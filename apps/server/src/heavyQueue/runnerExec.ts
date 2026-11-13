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
import { parseLine, type Word } from "./shellLine.ts";
import {
  foldMarker,
  HEARTBEAT_COMMAND,
  MARKER,
  NO_PROGRESS,
  parseHeartbeat,
  installFailure,
  platformFailures,
  remoteOutcome,
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
const macPath = (word: Word, value: string, home: string) => {
  if (word.tilde && /^~(\/|$)/.test(value)) return home + value.slice(1);
  const homeVar = /^\$(HOME|\{HOME\})(?=\/|$)/.exec(value);
  if (homeVar !== null && word.vars.length === 1) return home + value.slice(homeVar[0].length);
  return value.startsWith("/") && word.vars.length === 0 ? value : null;
};

/**
 * A `sh -c` text as Linux runs it: each word naming a path in `root` (also a `--flag=` value or a
 * redirect target) points at the copy instead, through `$T3_COPY`, which the wrapper sets there.
 * Linux has no Mac home, so `cd ~/<checkout>/sub` would land in a folder that doesn't exist.
 */
const shellTextInCopy = (text: string, root: string, home: string) => {
  const edits: Array<{ readonly start: number; readonly end: number; readonly text: string }> = [];
  for (const command of parseLine(text).commands) {
    const targets = command.redirects.flatMap((redirect) =>
      redirect.target === null ? [] : [redirect.target],
    );
    for (const word of [...command.words, ...targets]) {
      const flag = /^-[\w.-]*=/.exec(word.value)?.[0] ?? "";
      const path = macPath(word, word.value.slice(flag.length), home);
      if (path === null) continue;
      const relative = NodePath.relative(root, NodePath.normalize(path));
      if (relative.startsWith("..") || NodePath.isAbsolute(relative)) continue;
      const copy = `"$T3_COPY"${relative === "" ? "" : shellQuote(`/${relative}`)}`;
      edits.push({
        start: word.start,
        end: word.end,
        text: `${flag === "" ? "" : shellQuote(flag)}${copy}`,
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
  env: ReadonlyArray<string> = [],
) => {
  const depth = NodePath.relative(root, cwd).split(NodePath.sep).filter(Boolean).length;
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
  return [
    "bash",
    "-c",
    `export T3_COPY="${folders[depth]}" PATH="${bins.join(":")}:$PATH"; command -v -- ${program} >/dev/null 2>&1 || { printf '\\036remoto missing=%s\\n' ${program} >&2; exit 127; }; ${settle}; exec "$@"`,
    "t3",
    ...(env.length === 0 ? [] : ["env", ...env]),
    ...command,
  ];
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
      { timeout: timeoutMs, env: { ...process.env, ...environment } },
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
): Promise<StopResult> => {
  const script = remoteStopScript(id, pgid, machine.runnerStopWaitSeconds);
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
  /** `NAME=value` pairs the command runs with there. */
  readonly env?: ReadonlyArray<string>;
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
    /** A package whose install was unfinished there, from the wrapper or the output. */
    readonly install: string | null;
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
      options.env,
    ),
    {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...options.environment,
        REMOTO_FALLBACK: "nao",
        REMOTO_HOST: machine.runnerHost,
        REMOTO_MARKERS: "1",
        REMOTO_TIMEOUT: String(machine.runnerSshTimeoutSeconds),
      },
    },
  );
  let progress: RemoteProgress = NO_PROGRESS;
  const platform = new Set<string>();
  let install: string | null = null;
  const scan = (line: string) => {
    for (const hit of platformFailures(line, options.macOnly)) platform.add(hit);
    install ??= installFailure(line);
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
  child.stdout.on("data", (chunk: Buffer) => {
    options.stdout(chunk);
    out.push(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk.toString("utf8")));
  const done = new Promise<{
    outcome: RemoteOutcome;
    progress: RemoteProgress;
    platform: ReadonlyArray<string>;
    install: string | null;
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
