// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * Runs a heavy job on Linux through `remoto`, and the ssh calls around it: the heartbeat and the
 * check that a stopped or dropped run left nothing behind. Plain Node, like the `t3 heavy` CLI
 * that calls it; the server's heartbeat reuses `checkLinux`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { RunnerMachineConfig } from "@t3tools/contracts";

import { shellQuote } from "./heavyHook.ts";
import { worktreeProblemOf } from "./heavyNotices.ts";
import { parseLine, type Word } from "./shellLine.ts";
import { claimLostRun, readDoc, resolveLostPgid, settleLostRun } from "./queueFile.ts";
import {
  foldMarker,
  HEARTBEAT_COMMAND,
  MARKER,
  NO_PROGRESS,
  parseHeartbeat,
  installFailure,
  platformFailures,
  remoteOutcome,
  remotePgidScript,
  remoteStopScript,
  removeCopyScript,
  sshArgs,
  type HealthCheck,
  type RemoteOutcome,
  type RemoteProgress,
} from "./runner.ts";

type Env = Readonly<Record<string, string | undefined>>;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);

/** The Mac path a word names (`~/…`, `$HOME/…` or absolute), or null for anything else. */
const macPath = (word: Word, value: string, home: string, tilde: boolean) => {
  if (tilde && /^~(\/|$)/.test(value)) return home + value.slice(1);
  const homeVar = /^\$(HOME|\{HOME\})(?=\/|$)/.exec(value);
  if (homeVar !== null && word.vars.length === 1) return home + value.slice(homeVar[0].length);
  return value.startsWith("/") && word.vars.length === 0 ? value : null;
};

/** One `:`-separated part of an unquoted `NAME=` value as a Mac path, or null when it is not one. */
const listPath = (part: string, home: string) => {
  const fromHome = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(part);
  const rest = fromHome === null ? part : part.slice(fromHome[0].length);
  if (rest.includes("$")) return null;
  if (fromHome !== null) return home + rest;
  return part.startsWith("/") ? part : null;
};

/**
 * A `sh -c` text as Linux runs it: each word naming a path in `root` (also a `--flag=` or `NAME=`
 * value, or a redirect target) points at the copy instead, through `$T3_COPY`, which the wrapper
 * sets there.
 * Linux has no Mac home, so `cd ~/<checkout>/sub` would land in a folder that doesn't exist.
 */
const shellTextInCopy = (text: string, root: string, home: string) => {
  const edits: Array<{ readonly start: number; readonly end: number; readonly text: string }> = [];
  const inCopy = (path: string) => {
    const relative = NodePath.relative(root, NodePath.normalize(path));
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) return null;
    return `"$T3_COPY"${relative === "" ? "" : shellQuote(`/${relative}`)}`;
  };
  for (const command of parseLine(text).commands) {
    const targets = command.redirects.flatMap((redirect) =>
      redirect.target === null ? [] : [redirect.target],
    );
    for (const word of [...command.assigns, ...command.words, ...targets]) {
      const name = /^[A-Za-z_]\w*=/.exec(word.value)?.[0];
      const raw = text.slice(word.start, word.end);
      // Unquoted, bash expands `~` after an identifier's `=` and after each `:` of its value.
      if (name !== undefined && raw.startsWith(name) && !/['"\\`]/.test(raw)) {
        const parts = raw.slice(name.length).split(":");
        const moved = parts.map((part) => {
          const path = listPath(part, home);
          return (path === null ? null : inCopy(path)) ?? part;
        });
        if (moved.some((part, at) => part !== parts[at])) {
          edits.push({ start: word.start, end: word.end, text: name + moved.join(":") });
        }
        continue;
      }
      const flag = name ?? /^-[\w.-]*=/.exec(word.value)?.[0] ?? "";
      // Quoted, bash expands `~` only right after an identifier's `=`, never after a flag's.
      const tilde = name === undefined ? word.tilde : text.startsWith(`${name}~`, word.start);
      const path = macPath(word, word.value.slice(flag.length), home, tilde);
      const copy = path === null ? null : inCopy(path);
      if (copy === null) continue;
      edits.push({
        start: word.start,
        end: word.end,
        // A quoted name would stop being an assignment.
        text: `${name ?? (flag === "" ? "" : shellQuote(flag))}${copy}`,
      });
    }
  }
  return edits
    .toSorted((a, b) => b.start - a.start)
    .reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), text);
};

/**
 * The command as Linux runs it from the same folder of its synced copy: a path inside `root`
 * becomes relative to `cwd` (alone or as `--flag=<path>`), the Mac's `$SHELL` becomes `bash`, and
 * a program elsewhere on the Mac goes by its name.
 */
export const remoteCommand = (
  program: string,
  args: ReadonlyArray<string>,
  cwd: string,
  root: string,
  home = NodeOS.homedir(),
) => {
  const local = (path: string) => {
    if (!NodePath.isAbsolute(path)) return null;
    const relative = NodePath.relative(root, path);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) return null;
    return NodePath.relative(cwd, path) || ".";
  };
  const arg = (value: string) => {
    const flag = /^(-[\w.-]*=)(.+)$/.exec(value);
    if (flag !== null) return flag[1]! + (local(flag[2]!) ?? flag[2]!);
    return local(value) ?? value;
  };
  const name = NodePath.basename(program);
  if (SHELLS.has(name)) {
    const text = args.findIndex((value) => /^-[a-z]*c[a-z]*$/.test(value)) + 1;
    return [
      "bash",
      ...args.map((value, at) =>
        at > 0 && at === text ? shellTextInCopy(value, root, home) : arg(value),
      ),
    ];
  }
  const inside = local(program);
  const remote =
    inside === null
      ? program.includes("/") && NodePath.isAbsolute(program)
        ? name
        : program
      : inside.startsWith(".")
        ? inside
        : `./${inside}`;
  return [remote, ...args.map(arg)];
};

const physical = (path: string) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Runs `command` with each `node_modules/.bin` from its folder up to the checkout first on PATH,
 * so Linux finds `vp` and `vitest` the way this Mac does: neither is global there, and
 * `remoto-rodar` sets its own PATH. Before it starts, a lazy install left unfinished in the copy
 * (Electron fetches its binary on first use) runs once, so the command's workers never race on it.
 */
export const withProjectBins = (
  command: ReadonlyArray<string>,
  cwd: string,
  root: string,
  startMarker: string | null = null,
) => {
  // `remoto` starts in `pwd -P` there: a link inside the checkout changes how deep that is.
  const depth = NodePath.relative(physical(root), physical(cwd))
    .split(NodePath.sep)
    .filter(Boolean).length;
  const folders = Array.from({ length: depth + 1 }, (_, up) =>
    up === 0 ? "$PWD" : `\${PWD%${"/*".repeat(up)}}`,
  );
  const bins = folders.map((folder) => `${folder}/node_modules/.bin`);
  // ponytail: Electron's install.js + path.txt only; add a row when another package fetches lazily.
  const electrons = folders.flatMap((folder) => [
    `"${folder}"/node_modules/electron`,
    `"${folder}"/node_modules/.pnpm/electron@*/node_modules/electron`,
  ]);
  const settle = `for e in ${electrons.join(" ")}; do [ -f "$e/install.js" ] || continue; [ -f "$e/path.txt" ] && [ -e "$e/dist/$(cat "$e/path.txt")" ] && continue; printf '\\036remoto phase=installing\\n' >&2; (cd "$e" && node install.js) >&2 || { printf '\\036remoto install=electron\\n' >&2; exit 1; }; printf '\\036remoto phase=running\\n' >&2; done`;
  // The pre-flight: a program Linux can't find never starts, and says which one it was.
  const program = shellQuote(command[0] ?? "");
  // The job holds Linux already: a `remoto` it calls inside runs in place. Shared by every copy.
  const passthrough = `b="\${T3_COPY%/*}/.t3-bin"; [ -x "$b/remoto" ] || { mkdir -p "$b" && printf '#!/bin/sh\\nexec "$@"\\n' > "$b/remoto.$$" && chmod +x "$b/remoto.$$" && mv -f "$b/remoto.$$" "$b/remoto"; } && export PATH="$b:$PATH";`;
  // Bring results back: what the command writes after this is newer than the marker.
  const mark =
    startMarker === null ? "" : ` touch -- "$T3_COPY"${shellQuote(markerSuffix(startMarker))};`;
  return [
    "bash",
    "-c",
    `${READ_ENV}; export T3_COPY="${folders[depth]}" PATH="${bins.join(":")}:$PATH"; command -v -- ${program} >/dev/null 2>&1 || { printf '\\036remoto missing=%s\\n' ${program} >&2; exit 127; }; ${passthrough} ${settle};${mark} eval "$t3v"; exec "$@"`,
    "t3",
    ...command,
  ];
};

/** Reads `envHeader` off stdin into `$t3v` (applied right before the command), byte by byte so the input after it stays unread. */
export const READ_ENV = 'IFS= read -r t3n && t3v=$(dd bs=1 count="$t3n" 2>/dev/null)';

/**
 * What a run there starts with on its stdin: the byte length, then `export NAME='value'` for each
 * pair, and without `input` a redirect from /dev/null. Values never go in argv, which `ps` shows.
 */
const envHeader = (env: ReadonlyArray<string>, input: boolean) => {
  const lines = env.flatMap((pair) => {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    return /^[A-Za-z_]\w*$/.test(name)
      ? [`export ${name}=${shellQuote(pair.slice(at + 1))}\n`]
      : [];
  });
  const body = `${lines.join("")}${input ? "" : "exec </dev/null\n"}`;
  return `${Buffer.byteLength(body)}\n${body}`;
};

const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Beside the copy (`runs/<id>.t3-start-<job>`), so `remoto`'s sync never deletes it. */
const markerSuffix = (job: string) => {
  if (!SAFE_NAME.test(job)) throw new Error(`Unsafe job id: ${job}`);
  return `.t3-start-${job}`;
};

type Git = (args: ReadonlyArray<string>) => string | null;

const gitIn =
  (root: string): Git =>
  (args) => {
    try {
      return NodeChildProcess.execFileSync("git", ["-c", "core.quotePath=false", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };

const CHANGED_SCRIPT = "check:changed";

/** The project's `check:changed` reads the inputs the Runner hands it, so it runs without git. */
const takesChangedInputs = (cwd: string, root: string) => {
  for (let dir = cwd; ; dir = NodePath.dirname(dir)) {
    try {
      const scripts = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "package.json"), "utf8"))
        ?.scripts as Record<string, unknown> | undefined;
      const script = scripts?.[CHANGED_SCRIPT];
      if (typeof script === "string") {
        return script
          .split(/\s+/)
          .filter((word) => /\.[cm]?[jt]s$/.test(word))
          .some((file) => {
            try {
              return NodeFS.readFileSync(NodePath.join(dir, file), "utf8").includes(
                "CHECK_CHANGED_FILES",
              );
            } catch {
              return false;
            }
          });
      }
    } catch {
      // No package.json here: look further up.
    }
    if (dir === root || dir === NodePath.dirname(dir)) return false;
  }
};

/**
 * What `check:changed` would ask git, answered on this Mac for a Linux copy without `.git`: the
 * merge base with the closest `<remote>/main` (or the ref it names) and the changed and untracked
 * files, as `env` assignments. Null when it is not that check, or Linux can't run it.
 */
export const changedInputs = (
  args: ReadonlyArray<string>,
  cwd: string,
  root: string,
  git: Git = gitIn(root),
): ReadonlyArray<string> | null => {
  const at = args.indexOf(CHANGED_SCRIPT);
  if (at < 0 || !takesChangedInputs(cwd, root)) return null;
  // Its own `--timeout 3300` and `--concurrency 4` take a value; any other word is the ref.
  const explicit = args
    .slice(at + 1)
    .find(
      (arg, index, rest) =>
        !arg.startsWith("-") && !/^--(timeout|concurrency)$/.test(rest[index - 1] ?? ""),
    );
  const candidates =
    explicit === undefined
      ? (git(["remote"]) ?? "")
          .split("\n")
          .filter(Boolean)
          .map((name) => ({ ref: `${name}/main`, rev: `refs/remotes/${name}/main` }))
      : [{ ref: explicit, rev: explicit }];
  let best: { ref: string; base: string; ahead: number } | undefined;
  for (const { ref, rev } of candidates) {
    const base = git(["merge-base", "HEAD", rev]);
    if (!base) continue;
    const ahead = Number(git(["rev-list", "--count", `${base}..HEAD`]));
    if (best === undefined || ahead < best.ahead) best = { ref, base, ahead };
  }
  if (best === undefined) return null;
  const listed = (more: ReadonlyArray<string>) => (git(more) ?? "").split("\n").filter(Boolean);
  const files = [
    ...new Set([
      ...listed(["diff", "--name-only", "--no-renames", best.base, "--"]),
      ...listed(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ].sort();
  return [
    `CHECK_CHANGED_BASE=${best.base}`,
    `CHECK_CHANGED_REF=${best.ref}`,
    `CHECK_CHANGED_FILES=${files.join("\n")}`,
  ];
};

const executable = (path: string) => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `remoto` from PATH, else where its installer links it; `T3CODE_REMOTO` overrides both. */
export const resolveRemoto = (environment: Env): string | null => {
  if (environment.T3CODE_REMOTO !== undefined) return environment.T3CODE_REMOTO;
  const dirs = (environment.PATH ?? "").split(NodePath.delimiter).filter((dir) => dir !== "");
  const home = environment.HOME ?? NodeOS.homedir();
  for (const dir of [...dirs, NodePath.join(home, ".local", "bin")]) {
    const candidate = NodePath.join(dir, "remoto");
    if (executable(candidate)) return candidate;
  }
  return null;
};

const sshProgram = (environment: Env) => environment.T3CODE_RUNNER_SSH ?? "ssh";

const ssh = (
  machine: RunnerMachineConfig,
  environment: Env,
  command: string,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      sshProgram(environment),
      sshArgs(machine, environment, command),
      { timeout: timeoutMs, env: { ...process.env, ...environment }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** One heartbeat: load, cores and memory, or why ssh could not get them. */
export const checkLinux = async (
  machine: RunnerMachineConfig,
  environment: Env,
): Promise<HealthCheck> => {
  // ssh enforces ConnectTimeout; the outer limit only covers a host that accepts and then hangs.
  const result = await ssh(
    machine,
    environment,
    HEARTBEAT_COMMAND,
    (machine.runnerSshTimeoutSeconds + machine.runnerHeartbeatSeconds) * 1000,
  );
  if (result.code === 0) return { ok: true, reading: parseHeartbeat(result.stdout) };
  const why = result.stderr.trim().split("\n").pop() ?? "";
  return { ok: false, error: why === "" ? `ssh exited ${result.code ?? "on timeout"}` : why };
};

const run = (
  program: string,
  args: ReadonlyArray<string>,
  environment: Env,
): Promise<{ readonly code: number | null; readonly stdout: string }> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      program,
      args,
      { env: { ...process.env, ...environment } },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout: String(stdout) });
      },
    );
  });

export interface BroughtBack {
  readonly copied: ReadonlyArray<string>;
  /** Changed on this Mac after `since`: left as they are. */
  readonly skipped: ReadonlyArray<string>;
  /** Deleted there and still here: deletions are never applied. */
  readonly deleted: ReadonlyArray<string>;
  /** Bytes the copy would have taken when over `maxBytes`; then nothing is copied. */
  readonly overCap: number | null;
}

/** A `find -name` pattern (`*`, `?`) as a whole-name test. */
const nameMatcher = (patterns: ReadonlyArray<string>) => {
  const sources = patterns.map(
    (pattern) =>
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
  );
  const test = sources.length === 0 ? null : new RegExp(sources.join("|"));
  return (name: string) => test !== null && test.test(name);
};

/** Of `paths` (relative to `root`), the ones git ignores there: they never travel to Linux. */
const ignoredHere = (root: string, paths: ReadonlyArray<string>) => {
  if (paths.length === 0) return new Set<string>();
  const result = NodeChildProcess.spawnSync("git", ["-C", root, "check-ignore", "--stdin"], {
    input: `${paths.join("\n")}\n`,
    encoding: "utf8",
  });
  return new Set(typeof result.stdout === "string" ? result.stdout.split("\n") : []);
};

/** Changed folders whose entries are compared for deletions. */
const DELETION_FOLDERS = 500;

/**
 * Copies to `root` what job `job` changed in copy `copyId` after its start marker, except names
 * matching `exclude` and files this Mac changed after `since`, keeping their modes; null when
 * that fails. Nothing is copied when it comes to more than `maxBytes`. Each side reads its own
 * clock: change times there (synced files keep this Mac's mtimes).
 */
export const bringBack = async (options: {
  readonly machine: RunnerMachineConfig;
  readonly environment: Env;
  readonly copyId: string;
  readonly job: string;
  readonly root: string;
  readonly since: number;
  readonly exclude: ReadonlyArray<string>;
  readonly maxBytes: number;
}): Promise<BroughtBack | null> => {
  const { machine, environment, copyId, root } = options;
  if (!SAFE_NAME.test(copyId) || !SAFE_NAME.test(options.job)) return null;
  const marker = `../${copyId}${markerSuffix(options.job)}`;
  const prune =
    options.exclude.length === 0
      ? ""
      : `\\( ${options.exclude.map((name) => `-name ${shellQuote(name)}`).join(" -o ")} \\) -prune -o`;
  // NUL-separated records: a newline in a file name can't forge another. Each file is sized on
  // its own, so a `find` that failed partway exits non-zero instead of reading as a full listing.
  // ponytail: deletions are found in the first DELETION_FOLDERS changed folders only, by their
  // direct entries; a full tree diff if a deeper count ever matters.
  const swap = `tr '\\n\\000' '\\000\\n'`;
  const listed = await ssh(
    machine,
    environment,
    [
      `cd runs/${copyId} && [ -e ${marker} ] || exit 1`,
      `find . ${prune} -type f -cnewer ${marker} -exec sh -c 'for f; do printf "F %s %s\\000" $(wc -c < "$f") "$f"; done' sh {} + || exit 1`,
      // Swapped, each record is one line for `head`.
      `find . ${prune} -type d -cnewer ${marker} -print0 | ${swap} | head -n ${DELETION_FOLDERS} | ${swap} | xargs -0 sh -c 'for d; do printf "D %s\\000" "$d"; find "$d" -mindepth 1 -maxdepth 1 -exec printf "E %s\\000" {} +; done' sh`,
      `rm -f ${marker}`,
    ].join("\n"),
    (machine.runnerSshTimeoutSeconds + 60) * 1000,
  );
  if (listed.code !== 0) return null;
  const excluded = nameMatcher(options.exclude);
  // What a job there names is checked here too: nothing lands outside the checkout, in `.git`, or
  // under a name the setting leaves out.
  const safe = (path: string) =>
    path
      .split("/")
      .every(
        (name) =>
          name !== "" && name !== "." && name !== ".." && name !== ".git" && !excluded(name),
      );
  const relative = (path: string) => (path === "." ? "" : path.replace(/^\.\//, ""));
  const copied: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  const folders: string[] = [];
  const there = new Set<string>();
  for (const record of listed.stdout.split("\0")) {
    const file = /^F (\d+) \.\/([\s\S]+)$/.exec(record);
    if (file !== null) {
      const path = file[2]!;
      if (!safe(path)) continue;
      let changedHere = false;
      try {
        changedHere = NodeFS.statSync(NodePath.join(root, path)).mtimeMs > options.since;
      } catch {
        // Not on this Mac: the job created it.
      }
      if (changedHere) skipped.push(path);
      else {
        copied.push(path);
        bytes += Number(file[1]);
      }
    } else if (record.startsWith("D ")) {
      const folder = relative(record.slice(2));
      if (folder === "" || safe(folder)) folders.push(folder);
    } else if (record.startsWith("E ")) there.add(relative(record.slice(2)));
  }
  const missing: string[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = NodeFS.readdirSync(NodePath.join(root, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = folder === "" ? name : `${folder}/${name}`;
      // `remoto` never sends these.
      if (there.has(path) || excluded(name) || name === ".git" || name === ".DS_Store") continue;
      try {
        if (NodeFS.lstatSync(NodePath.join(root, path)).mtimeMs > options.since) continue;
      } catch {
        continue;
      }
      missing.push(path);
    }
  }
  const ignored = ignoredHere(root, missing);
  const deleted = missing.filter((path) => !ignored.has(path)).sort();
  if (bytes > options.maxBytes) return { copied: [], skipped, deleted, overCap: bytes };
  if (copied.length > 0) {
    const listDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bring-back-"));
    try {
      const list = NodePath.join(listDir, "files");
      NodeFS.writeFileSync(list, `${copied.join("\0")}\0`);
      const shell = [
        sshProgram(environment),
        // A link lost mid-copy ends it, as `remoto` does, instead of hanging the job.
        "-o",
        "ServerAliveInterval=30",
        ...sshArgs(machine, environment, "").slice(0, -2),
      ];
      const sent = await run(
        // The one `remoto` uses (openrsync on macOS).
        environment.T3CODE_RUNNER_RSYNC ?? "/usr/bin/rsync",
        [
          // Keeps modes: a script made executable there stays executable here.
          "-p",
          "-e",
          shell.join(" "),
          "--from0",
          `--files-from=${list}`,
          `${machine.runnerHost}:runs/${copyId}/`,
          `${root}/`,
        ],
        environment,
      );
      if (sent.code !== 0) return null;
    } finally {
      NodeFS.rmSync(listDir, { recursive: true, force: true });
    }
  }
  return { copied, skipped, deleted, overCap: null };
};

export type CopyRemovalResult = "removed" | "busy" | "unreachable";

/** Deletes the Linux copy of a removed worktree; anything but a confirmed answer leaves it pending. */
export const removeRunnerCopy = async (
  machine: RunnerMachineConfig,
  environment: Env,
  id: string,
): Promise<CopyRemovalResult> => {
  const result = await ssh(
    machine,
    environment,
    removeCopyScript(id),
    (machine.runnerSshTimeoutSeconds + 60) * 1000,
  );
  const said = result.stdout.trim().split("\n").pop();
  return result.code === 0 && (said === "removed" || said === "busy") ? said : "unreachable";
};

export type StopResult = "gone" | "stopped" | "killed" | "alive" | "unreachable";

/** Ends whatever is left of run `id` there; only "alive" and "unreachable" leave it unconfirmed. */
export const stopRemote = async (
  machine: RunnerMachineConfig,
  environment: Env,
  id: string,
  pgid: number | null,
  pgidOnly = false,
): Promise<StopResult> => {
  const script = remoteStopScript(id, pgid, machine.runnerStopWaitSeconds, pgidOnly);
  const result = await ssh(
    machine,
    environment,
    script,
    // The script waits up to the stop wait, plus its KILL pass, after ssh connects.
    (machine.runnerSshTimeoutSeconds + 2 * machine.runnerStopWaitSeconds) * 1000,
  );
  const said = result.stdout.trim().split("\n").pop();
  if (said === "gone" || said === "stopped" || said === "killed" || said === "alive") return said;
  return "unreachable";
};

export const confirmed = (result: StopResult) => result !== "alive" && result !== "unreachable";

/** The pgid file of run `id` there: its process group, null with none, or "unreachable". */
export const readRemotePgid = async (
  machine: RunnerMachineConfig,
  environment: Env,
  id: string,
): Promise<number | null | "unreachable"> => {
  const result = await ssh(
    machine,
    environment,
    remotePgidScript(id),
    machine.runnerSshTimeoutSeconds * 1000 + 5000,
  );
  const said = result.stdout.trim().split("\n").pop() ?? "";
  if (result.code !== 0) return "unreachable";
  if (said === "none") return null;
  const pgid = /^pgid (\d+)$/.exec(said)?.[1];
  if (pgid === undefined) return "unreachable";
  // A group of 0 or 1 is never a run's own: `kill -- -1` would reach every process there.
  return Number(pgid) > 1 ? Number(pgid) : null;
};

/**
 * Keeps stopping the runs Linux took with it until it confirms each one ended, whether or not its
 * job still waits. Each heartbeat that reaches Linux calls it. Stops at the first unreachable answer.
 */
export const drainLostRuns = async (
  dir: string,
  machine: RunnerMachineConfig,
  environment: Env,
  remote: { readonly stop: typeof stopRemote; readonly readPgid: typeof readRemotePgid } = {
    stop: stopRemote,
    readPgid: readRemotePgid,
  },
) => {
  // Past the ssh timeout and both stop waits, the claiming process's stop has ended.
  const holdMs = (machine.runnerSshTimeoutSeconds + 2 * machine.runnerStopWaitSeconds + 5) * 1000;
  for (const lost of readDoc(dir).lostRuns) {
    const claim = Date.now() + holdMs;
    if (!claimLostRun(dir, lost, claim)) continue;
    let pgid = lost.remote.pgid;
    if (lost.pgidOnly === true && pgid === null) {
      // Its record still holds the folder, so the pgid file there is still the lost run's.
      const read = await remote.readPgid(machine, environment, lost.remote.id);
      if (read === "unreachable") {
        settleLostRun(dir, lost, false, claim);
        return;
      }
      // No group to stop it by, but nothing new ran in the folder yet: the whole stop is still safe.
      if (read !== null) resolveLostPgid(dir, lost, read);
      pgid = read;
    }
    const result = await remote.stop(
      machine,
      environment,
      lost.remote.id,
      pgid,
      lost.pgidOnly === true && pgid !== null,
    );
    settleLostRun(dir, lost, confirmed(result), claim);
    if (result === "unreachable") return;
  }
};

export interface LinuxRunOptions {
  readonly remoto: string;
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** The checkout `remoto` syncs from `cwd`. */
  readonly root: string;
  readonly environment: Env;
  readonly machine: RunnerMachineConfig;
  readonly macOnly: ReadonlyArray<string>;
  /** `NAME=value` pairs the command runs with there, sent on its stdin ahead of `input`. */
  readonly env?: ReadonlyArray<string>;
  /** The job whose start the wrapper marks there, so `bringBack` finds what it wrote. */
  readonly startMarker?: string;
  /** An fd `remoto` gets as its stdin and passes to the command there (`forwardedInput`). */
  readonly input?: number;
  /** Reads `input` by position from here (`fileOffset`), never moving its offset, so never spent. */
  readonly inputStart?: number;
  readonly onProgress: (progress: RemoteProgress) => void;
  readonly stdout: (chunk: Buffer) => void;
  readonly stderr: (text: string) => void;
}

export interface LinuxRun {
  readonly done: Promise<{
    readonly outcome: RemoteOutcome;
    readonly progress: RemoteProgress;
    /** Output lines naming Mac-only files, for a failed run. */
    readonly platform: ReadonlyArray<string>;
    /** A package whose install was unfinished there, from the wrapper or the output before the command. */
    readonly install: string | null;
    /** The fix for a dependency install the worktree's own files broke, before the command ran. */
    readonly worktree: string | null;
    /** It took bytes off an `input` read in place: a rerun would not get them. */
    readonly spentInput: boolean;
  }>;
  /** Ends the local `remoto`; the caller then confirms the remote side with `stopRemote`. */
  readonly kill: (signal: NodeJS.Signals) => void;
}

const lineSplitter = (onLine: (line: string, newline: boolean) => void) => {
  let pending = "";
  return {
    push: (text: string) => {
      pending += text;
      let at = pending.indexOf("\n");
      while (at >= 0) {
        onLine(pending.slice(0, at), true);
        pending = pending.slice(at + 1);
        at = pending.indexOf("\n");
      }
    },
    end: () => {
      if (pending !== "") onLine(pending, false);
      pending = "";
    },
  };
};

/** `fd` when it is a pipe or a file: a TTY or `/dev/null` is no input to send to Linux. */
export const forwardedInput = (fd: number) => {
  try {
    const stat = NodeFS.fstatSync(fd);
    return stat.isFIFO() || stat.isFile() ? fd : undefined;
  } catch {
    return undefined;
  }
};

/** Where a file's reader is on `fd`, from `lsof`; null when it can't tell. */
export const fileOffset = (fd: number) => {
  try {
    const out = NodeChildProcess.execFileSync(
      "lsof",
      ["-a", "-p", String(process.pid), "-d", String(fd), "-o", "-F", "o"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 },
    );
    const found = /^o0([tx])([0-9a-f]+)$/m.exec(out);
    return found === null ? null : Number.parseInt(found[2]!, found[1] === "t" ? 10 : 16);
  } catch {
    return null;
  }
};

/**
 * `REMOTO_FALLBACK=nao`, so an unreachable host exits 75 instead of running here. Output passes
 * through unchanged except the marker lines, which become progress.
 */
export const startLinuxRun = (options: LinuxRunOptions): LinuxRun => {
  const { machine } = options;
  const child = NodeChildProcess.spawn(
    options.remoto,
    withProjectBins(
      remoteCommand(options.program, options.args, options.cwd, options.root),
      options.cwd,
      options.root,
      options.startMarker ?? null,
    ),
    {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...options.environment,
        // Without it `remoto` runs `ssh -n`, which hands the command no stdin, so no `envHeader`.
        REMOTO_STDIN: "1",
        REMOTO_FALLBACK: "nao",
        REMOTO_HOST: machine.runnerHost,
        REMOTO_MARKERS: "1",
        REMOTO_TIMEOUT: String(machine.runnerSshTimeoutSeconds),
      },
    },
  );
  // `remoto` may end without reading it (Linux unreachable): a write after that is no error.
  child.stdin?.on("error", () => {});
  child.stdin?.write(envHeader(options.env ?? [], options.input !== undefined));
  let spentInput = false;
  if (options.input === undefined) child.stdin?.end();
  else if (child.stdin !== null) {
    NodeFS.createReadStream("", {
      fd: options.input,
      autoClose: false,
      ...(options.inputStart === undefined ? {} : { start: options.inputStart }),
    })
      .on("data", () => {
        spentInput ||= options.inputStart === undefined;
      })
      .on("error", () => child.stdin?.end())
      .pipe(child.stdin);
  }
  let progress: RemoteProgress = NO_PROGRESS;
  const platform = new Set<string>();
  let install: string | null = null;
  let worktree: string | null = null;
  const scan = (line: string) => {
    for (const hit of platformFailures(line, options.macOnly)) platform.add(hit);
    // Only the steps before the command: its own output may quote the same errors (a test name).
    if (progress.running) return;
    install ??= installFailure(line);
    worktree ??= worktreeProblemOf(line);
  };
  const out = lineSplitter(scan);
  const err = lineSplitter((line, newline) => {
    // A command whose last line has no newline puts the exit marker right after its text.
    const at = line.indexOf(MARKER);
    if (at >= 0) {
      if (at > 0) options.stderr(line.slice(0, at));
      progress = foldMarker(progress, line.slice(at));
      options.onProgress(progress);
      return;
    }
    scan(line);
    options.stderr(newline ? `${line}\n` : line);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    options.stdout(chunk);
    out.push(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => err.push(chunk.toString("utf8")));
  const done = new Promise<{
    outcome: RemoteOutcome;
    progress: RemoteProgress;
    platform: ReadonlyArray<string>;
    install: string | null;
    worktree: string | null;
    spentInput: boolean;
  }>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      out.end();
      err.end();
      resolve({
        outcome: remoteOutcome(progress),
        progress,
        platform: [...platform],
        install: progress.install ?? install,
        worktree,
        spentInput,
      });
    };
    child.on("error", (error) => {
      options.stderr(`[t3 heavy] cannot run remoto: ${error.message}\n`);
      finish();
    });
    child.on("close", finish);
  });
  return {
    done,
    kill: (signal) => {
      child.kill(signal);
    },
  };
};
