// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * `t3 heavy [--name <title>] [--priority high|low] [--now] [--queue-dir <dir>] -- <program> [args...]`:
 * waits for a heavy slot on the machine the Runner picks, then runs the program there. `--now`
 * skips the wait, as the user's Start now does. `t3 heavy hook` is the Claude Code
 * PreToolUse hook that puts heavy Bash commands behind it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

import type { RunnerMachineConfig, RunnerWhere } from "@t3tools/contracts";

import {
  HEAVY_JOB_ENV,
  heavyRoute,
  lineParts,
  readLine,
  rewriteLine,
  scriptOf,
  shellQuote,
  UNREADABLE_SCRIPT,
} from "./heavyHook.ts";
import { commitRoute } from "./commitHooks.ts";
import { faultOf, type FaultSeen, unreachableLine } from "./heavyNotices.ts";
import { readMemorySync, swapInRate } from "./hostReader.ts";
import {
  answerBashCall,
  claimHealthCheck,
  configFor,
  defaultQueueDir,
  enqueue,
  finish,
  gitRootOf,
  syncedInCopy,
  modeFor,
  readDoc,
  recordFault,
  recordHealth,
  recordSampleIfStale,
  requeue,
  scriptReader,
  setProgress,
  setQos,
  tryStart,
} from "./queueFile.ts";
import {
  DEFAULT_MACHINE_CONFIG,
  INSTALL_FAILED,
  linkAttempts,
  bodyVerdict,
  linkMachine,
  movedPart,
  NEEDS_GIT,
  needsGit,
  programTie,
  outsideTie,
  shellTextOf,
  startFolder,
} from "./runner.ts";
import {
  bringBack,
  changedInputs,
  checkLinux,
  confirmed,
  drainLostRuns,
  resolveRemoto,
  startLinuxRun,
  stopRemote,
} from "./runnerExec.ts";
import type { QueuedEntry, RemoteOutcome } from "./runner.ts";

/**
 * CPU priority an agent's job starts with on macOS; the user's own jobs always run normal.
 * "background" is `taskpolicy -b`. Adopt it only if scripts/heavy-priority-bench.sh shows it
 * within ~15% of normal on a free machine.
 */
const AGENT_JOB_CPU = "normal" as "normal" | "background";

/**
 * The program a job runs as, under `taskpolicy -b` when it starts in the background on macOS, and
 * the QoS to record; none off macOS, where T3 cannot change it later.
 */
export const launchOf = (
  program: string,
  args: ReadonlyArray<string>,
  background: boolean,
  platform: NodeJS.Platform,
) =>
  platform !== "darwin"
    ? { program, args, qos: null }
    : background
      ? {
          program: "/usr/sbin/taskpolicy",
          args: ["-b", program, ...args],
          qos: "background" as const,
        }
      : { program, args, qos: "normal" as const };

const POLL_MS = 1000;
/** A server writes readings every 2 s; past this a waiter takes over sampling. */
const SAMPLE_STALE_MS = 5000;
const LABEL_CHARS = 200;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const WAITING_EXIT: Record<(typeof SIGNALS)[number], number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);

export const parseHeavyArgs = (args: ReadonlyArray<string>) => {
  let rest = args;
  let dir = defaultQueueDir();
  let name: string | undefined;
  let priority: "low" | "normal" | "high" | undefined;
  let where: "mac" | "linux" | "automatic" | undefined;
  let requestId: string | undefined;
  let routeReason: string | undefined;
  let now = false;
  const options = [
    "--queue-dir",
    "--name",
    "--priority",
    "--runner",
    "--request-id",
    "--route-reason",
  ];
  // Another T3 version's option, before the separator: skipped with its value, never run.
  const foreign = (flag: string | undefined) =>
    flag !== undefined && flag !== "--" && flag.startsWith("--") && args.includes("--");
  while (
    rest[0] === "--now" ||
    (rest[1] !== undefined && options.includes(rest[0]!)) ||
    foreign(rest[0])
  ) {
    if (rest[0] !== "--now" && !options.includes(rest[0]!)) {
      rest = rest.slice(rest[1]!.startsWith("-") ? 1 : 2);
      continue;
    }
    if (rest[0] === "--now" || rest[1] === undefined) {
      now = true;
      rest = rest.slice(1);
      continue;
    }
    if (rest[0] === "--name") name = rest[1].trim().slice(0, 60) || undefined;
    else if (rest[0] === "--priority") {
      if (rest[1] === "low" || rest[1] === "normal" || rest[1] === "high") priority = rest[1];
    } else if (rest[0] === "--runner") {
      if (rest[1] === "mac" || rest[1] === "linux" || rest[1] === "automatic") where = rest[1];
    } else if (rest[0] === "--request-id") requestId = rest[1].trim() || undefined;
    else if (rest[0] === "--route-reason") routeReason = rest[1].trim().slice(0, 200) || undefined;
    else dir = rest[1];
    rest = rest.slice(2);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  return {
    dir,
    name,
    priority,
    where,
    now,
    ...(requestId === undefined ? {} : { requestId }),
    ...(routeReason === undefined ? {} : { routeReason }),
    program: rest[0],
    args: rest.slice(1),
  };
};

/**
 * The job a command really is. A shell line's leading `cd <dir> &&` steps become the folder it
 * starts from, so the queue, its project settings and Linux all see that folder, and an agent's own
 * `remoto` around the command is dropped.
 */
export const jobOf = (
  program: string,
  args: ReadonlyArray<string>,
  cwd: string,
  home: string,
): {
  readonly cwd: string;
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly remoto: boolean;
} => {
  if (NodePath.basename(program) === "remoto" && args[0] !== undefined) {
    return { cwd, program: args[0], args: args.slice(1), remoto: true };
  }
  if (!SHELLS.has(NodePath.basename(program)) || args[0] !== "-c" || args[1] === undefined) {
    return { cwd, program, args, remoto: false };
  }
  const parts = lineParts(args[1]);
  return {
    cwd: startFolder(parts.dirs, cwd, home),
    program,
    args: ["-c", parts.command, ...args.slice(2)],
    remoto: parts.remoto,
  };
};

export type HeavyLaunch =
  | { readonly kind: "direct" }
  | {
      readonly kind: "queue";
      readonly cwd: string;
      readonly program: string;
      readonly args: ReadonlyArray<string>;
      readonly where: RunnerWhere | undefined;
      /** A commit whose hook runs goes ahead of other waiters: it is short and blocks its agent. */
      readonly priority?: "high";
    };

/**
 * Run the command as written, or queue it. An agent's own `remoto` call never holds a Mac slot:
 * with the Runner on it is queued as a Linux job, and with it off `remoto` runs and falls back by
 * itself.
 */
export const heavyLaunch = (
  command: {
    readonly program: string;
    readonly args: ReadonlyArray<string>;
    readonly where: RunnerWhere | undefined;
  },
  cwd: string,
  home: string,
  modeAt: (cwd: string) => { readonly enabled: boolean; readonly runner: boolean },
  inJob: boolean,
): HeavyLaunch => {
  // Inside a queue job the slot is already held; queuing again would wait on itself.
  if (inJob) return { kind: "direct" };
  const job = jobOf(command.program, command.args, cwd, home);
  const mode = modeAt(job.cwd);
  if (heavyRoute(mode) === "direct" || (job.remoto && !mode.runner)) return { kind: "direct" };
  const commit = job.remoto ? null : commitRoute(jobLine(job.program, job.args), job.cwd);
  if (commit === "direct") return { kind: "direct" };
  return {
    kind: "queue",
    cwd: job.cwd,
    program: job.program,
    args: job.args,
    where: job.remoto ? (command.where ?? "linux") : command.where,
    ...(commit === "first" ? { priority: "high" as const } : {}),
  };
};

/**
 * A hook-wrapped `$SHELL -c '<line>'` is labelled by the line itself, so names and history keep it.
 * Any other program by its name, as Linux runs it (`remoteCommand`).
 */
export const labelOf = (program: string, args: ReadonlyArray<string>) =>
  (isShellLine(program, args) ? args[1]! : [NodePath.basename(program), ...args].join(" ")).slice(
    0,
    LABEL_CHARS,
  );

const isShellLine = (program: string, args: ReadonlyArray<string>) =>
  SHELLS.has(NodePath.basename(program)) && args[0] === "-c" && args[1] !== undefined;

/** The line a job runs, as a shell reads it: a program run without a shell is its quoted words. */
const jobLine = (program: string, args: ReadonlyArray<string>) =>
  isShellLine(program, args) ? args[1]! : [program, ...args].map(shellQuote).join(" ");

/**
 * The shell and line a Linux job runs here: each work part goes through `executor`, the rest
 * stays in this shell.
 */
export const linuxLine = (program: string, args: ReadonlyArray<string>, executor: string) =>
  isShellLine(program, args)
    ? { shell: program, args: ["-c", rewriteLine(args[1]!, executor), ...args.slice(2)] }
    : { shell: "/bin/sh", args: ["-c", rewriteLine(jobLine(program, args), executor)] };

/**
 * Tools that size themselves by cores and the flag that caps them, placed right after the program
 * or its subcommand so it never lands past a `--`. `set` lists the flags (or `-D` properties) that
 * already pick a count; the command's own choice always stands.
 */
const WORKER_FLAGS: ReadonlyArray<{
  readonly programs: ReadonlyArray<string>;
  readonly subcommand?: RegExp;
  /** The program only runs in parallel under this flag (`node --test`). */
  readonly when?: RegExp;
  readonly set: ReadonlyArray<string>;
  readonly flag: (workers: number) => ReadonlyArray<string>;
}> = [
  // A flag reaches a reused daemon; `GRADLE_OPTS` only reaches the client JVM.
  {
    programs: ["gradle", "gradlew"],
    set: ["--max-workers", "-Dorg.gradle.workers.max"],
    flag: (n) => [`--max-workers=${n}`],
  },
  { programs: ["xcodebuild"], set: ["-jobs"], flag: (n) => ["-jobs", String(n)] },
  {
    programs: ["swift"],
    subcommand: /^(build|test|run)$/,
    set: ["-j", "--jobs"],
    flag: (n) => ["-j", String(n)],
  },
  {
    programs: ["node"],
    when: /^--test(=|$)/,
    set: ["--test-concurrency"],
    flag: (n) => [`--test-concurrency=${n}`],
  },
  {
    programs: ["playwright"],
    subcommand: /^test$/,
    set: ["--workers", "-j"],
    flag: (n) => [`--workers=${n}`],
  },
];

/**
 * Read by the tool wherever it runs in the job, nested scripts included; an explicit flag or an
 * inline assignment still wins. `make` is left out: it runs serially by default, so `MAKEFLAGS=-jN`
 * would only raise it, and an explicit `-j` beats `MAKEFLAGS` anyway.
 */
const WORKER_ENV = [
  "VITEST_MAX_WORKERS",
  "CARGO_BUILD_JOBS",
  "CMAKE_BUILD_PARALLEL_LEVEL",
] as const;

/** A file's text, or null when it is missing or unreadable. */
type ReadText = (path: string) => string | null;

const readText: ReadText = (path) => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** `dir` and each folder above it, up to the first one `last` accepts or the filesystem root. */
const foldersUp = (dir: string, last: (folder: string) => boolean = () => false) => {
  const folders = [NodePath.resolve(dir)];
  while (!last(folders.at(-1)!) && NodePath.dirname(folders.at(-1)!) !== folders.at(-1))
    folders.push(NodePath.dirname(folders.at(-1)!));
  return folders;
};

const counts = (texts: ReadonlyArray<string | null>, read: (text: string) => number | undefined) =>
  texts.flatMap((text) => {
    const count = text === null ? undefined : read(text);
    return count === undefined ? [] : [count];
  });

const GRADLE_MAX = /(?:^|\s)-Dorg\.gradle\.workers\.max=(\d+)/;

const gradleProperty = (text: string) => {
  const match = /^\s*org\.gradle\.workers\.max\s*[=:]\s*(\d+)\s*$/m.exec(text);
  return match === null ? undefined : Number(match[1]);
};

/** `build.jobs`, under `[build]` or dotted; a negative count means all cores but that many. */
const cargoJobs = (text: string) => {
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const header = /^\[\s*([\w.-]+)\s*\]$/.exec(line);
    if (header !== null) section = header[1]!;
    const pair = /^([\w.-]+)\s*=\s*(-?\d+)$/.exec(line);
    if (pair !== null && (section === "" ? pair[1] : `${section}.${pair[1]}`) === "build.jobs") {
      const jobs = Number(pair[2]);
      return jobs < 0 ? Math.max(1, NodeOS.availableParallelism() + jobs) : jobs;
    }
  }
  return undefined;
};

/** The program name and words after it of each command a job runs, its shell line's included. */
const commandsOf = (program: string, args: ReadonlyArray<string>) =>
  isShellLine(program, args)
    ? readLine(args[1]!).parts.map((part) => ({
        name: NodePath.basename(part.values[part.programAt] ?? ""),
        rest: part.values.slice(part.programAt + 1),
      }))
    : [{ name: NodePath.basename(program), rest: args }];

/**
 * The cap is a ceiling: a tool keeps a lower count its own config sets, and CMake's level only
 * goes to a build whose generator already runs in parallel (Make's runs one job at a time).
 */
const ownCounts = (
  program: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  project: { readonly cwd: string; readonly read: ReadText },
) => {
  const home = environment.HOME ?? NodeOS.homedir();
  const isRootProject = (folder: string) =>
    ["settings.gradle", "settings.gradle.kts"].some(
      (name) => project.read(NodePath.join(folder, name)) !== null,
    );
  const gradle = [
    ...counts(
      [
        ...foldersUp(project.cwd, isRootProject).map((folder) =>
          project.read(NodePath.join(folder, "gradle.properties")),
        ),
        project.read(
          NodePath.join(
            environment.GRADLE_USER_HOME ?? NodePath.join(home, ".gradle"),
            "gradle.properties",
          ),
        ),
      ],
      gradleProperty,
    ),
    ...counts([environment.GRADLE_OPTS ?? null, environment.JAVA_OPTS ?? null], (text) => {
      const match = GRADLE_MAX.exec(text);
      return match === null ? undefined : Number(match[1]);
    }),
  ];
  const cargo = counts(
    [
      ...foldersUp(project.cwd).flatMap((folder) =>
        ["config.toml", "config"].map((name) =>
          project.read(NodePath.join(folder, ".cargo", name)),
        ),
      ),
      project.read(
        NodePath.join(environment.CARGO_HOME ?? NodePath.join(home, ".cargo"), "config.toml"),
      ),
    ],
    cargoJobs,
  );
  const cmakeParallel = commandsOf(program, args).some(({ name, rest }) => {
    const at = rest.indexOf("--build");
    if (name !== "cmake" || at === -1 || rest[at + 1] === undefined) return false;
    const cache = project.read(NodePath.resolve(project.cwd, rest[at + 1]!, "CMakeCache.txt"));
    return cache !== null && /^CMAKE_GENERATOR:INTERNAL=(Ninja|Xcode)/m.test(cache);
  });
  return { gradle: Math.min(...gradle), cargo: Math.min(...cargo), cmakeParallel };
};

const setsCount = (args: ReadonlyArray<string>, set: ReadonlyArray<string>) =>
  args.some((arg) =>
    set.some(
      (flag) =>
        arg === flag ||
        arg.startsWith(`${flag}=`) ||
        // `-j4`: a short flag takes its value attached.
        (/^-\w$/.test(flag) && arg.startsWith(flag) && /^\d+$/.test(arg.slice(flag.length))),
    ),
  );

/** Where the capping flag goes among the words after the program; null when no row applies. */
const flagIndex = (
  program: string,
  args: ReadonlyArray<string>,
  workers: number,
  /** Programs whose own config already picks fewer workers. */
  keep: ReadonlySet<string>,
): { readonly at: number; readonly words: ReadonlyArray<string> } | null => {
  const name = NodePath.basename(program);
  const knob = WORKER_FLAGS.find((row) => row.programs.includes(name));
  if (knob === undefined || keep.has(name) || setsCount(args, knob.set)) return null;
  if (knob.when !== undefined && !args.some((arg) => knob.when!.test(arg))) return null;
  if (knob.subcommand !== undefined && !knob.subcommand.test(args[0] ?? "")) return null;
  return { at: knob.subcommand === undefined ? 0 : 1, words: knob.flag(workers) };
};

/** A shell line with each capped tool's flag spliced in after its program or subcommand. */
const lineWithWorkers = (line: string, workers: number, keep: ReadonlySet<string>) =>
  readLine(line)
    .parts.flatMap((part) => {
      const rest = part.values.slice(part.programAt + 1);
      const word = part.command.words[part.programAt];
      const insert = word === undefined ? null : flagIndex(word.value, rest, workers, keep);
      if (insert === null) return [];
      return [{ end: part.command.words[part.programAt + insert.at]!.end, words: insert.words }];
    })
    .toSorted((a, b) => b.end - a.end)
    .reduce(
      (text, edit) => `${text.slice(0, edit.end)} ${edit.words.join(" ")}${text.slice(edit.end)}`,
      line,
    );

/**
 * Tools that size themselves by cores take the admitted count instead: from the environment, or
 * from a flag when they are the program or a command of its shell line.
 */
export const withWorkers = (
  program: string,
  args: ReadonlyArray<string>,
  workers: number,
  environment: NodeJS.ProcessEnv,
  project: { readonly cwd: string; readonly read: ReadText },
) => {
  const own = ownCounts(program, args, environment, project);
  const keep = new Set(own.gradle < workers ? ["gradle", "gradlew"] : []);
  const direct = flagIndex(program, args, workers, keep);
  const capped = isShellLine(program, args)
    ? [args[0]!, lineWithWorkers(args[1]!, workers, keep), ...args.slice(2)]
    : direct === null
      ? args
      : [...args.slice(0, direct.at), ...direct.words, ...args.slice(direct.at)];
  return {
    args: capped,
    env: {
      ...environment,
      ...Object.fromEntries(
        WORKER_ENV.filter(
          (name) =>
            environment[name] === undefined &&
            !(name === "CARGO_BUILD_JOBS" && own.cargo < workers) &&
            (name !== "CMAKE_BUILD_PARALLEL_LEVEL" || own.cmakeParallel),
        ).map((name) => [name, String(workers)]),
      ),
      [HEAVY_JOB_ENV]: "1",
      T3_HEAVY_WORKERS: String(workers),
    },
  };
};

const cpuTimes = () =>
  NodeOS.cpus().reduce(
    (sum, cpu) => {
      const t = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return { idle: sum.idle + cpu.times.idle, total: sum.total + t };
    },
    { idle: 0, total: 0 },
  );

/** Instantaneous CPU from tick deltas between calls (not the load average); memory as the server reads it. */
const makeHostReader = () => {
  let last = cpuTimes();
  let lastSwap: { at: number; swapInBytes: number | null } | null = null;
  return () => {
    const now = cpuTimes();
    const total = now.total - last.total;
    const busy = total > 0 ? 1 - (now.idle - last.idle) / total : 0;
    last = now;
    const cpuCount = NodeOS.cpus().length;
    const memory = readMemorySync();
    const swap = { at: Date.now(), swapInBytes: memory.swapInBytes };
    const swapInBytesPerSecond = swapInRate(lastSwap, swap);
    lastSwap = swap;
    return {
      at: swap.at,
      busyCores: busy * cpuCount,
      cpuCount,
      availableMemoryBytes: memory.availableMemoryBytes,
      totalMemoryBytes: memory.totalMemoryBytes,
      pressureLevel: memory.pressureLevel,
      swapInBytesPerSecond,
    };
  };
};

/** How this same CLI is started again, for the command the hook writes. */
export const selfPrefix = (
  dir: string,
  environment: NodeJS.ProcessEnv = process.env,
  subcommand?: "linux-part",
) =>
  [
    ...(environment.ELECTRON_RUN_AS_NODE === "1" ? ["ELECTRON_RUN_AS_NODE=1"] : []),
    shellQuote(process.execPath),
    ...(NodeSea.isSea() || process.argv[1] === undefined
      ? []
      : [shellQuote(NodePath.resolve(process.argv[1]))]),
    "heavy",
    ...(subcommand === undefined ? [] : [subcommand]),
    "--queue-dir",
    shellQuote(dir),
  ].join(" ");

const readStdin = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

/** Fails open: any error prints nothing and exits 0, so Claude runs the command unchanged. */
const runHook = async (dir: string) => {
  try {
    const answer = answerBashCall(dir, JSON.parse(await readStdin()), selfPrefix(dir), process.env);
    if (answer !== null) process.stdout.write(JSON.stringify(answer));
  } catch {
    // Leave the call as Claude wrote it.
  }
};

const runDirect = (program: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
  const child = NodeChildProcess.spawn(program, args, { stdio: "inherit", env });
  child.on("error", (error) => {
    process.stderr.write(`[t3 heavy] cannot run ${program}: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? 128 + (signal ? (NodeOS.constants.signals[signal] ?? 0) : 0));
  });
  return child;
};

const exitCodeOf = (code: number | null, signal: NodeJS.Signals | null) =>
  code ?? 128 + (signal ? (NodeOS.constants.signals[signal] ?? 0) : 0);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const enterFolder = (cwd: string) => {
  try {
    process.chdir(cwd);
    return true;
  } catch {
    return false;
  }
};

export const runHeavyCli = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (argv[0] === "hook") {
    await runHook(parseHeavyArgs(argv.slice(1)).dir);
    return;
  }
  if (argv[0] === "linux-part") {
    const part = parseHeavyArgs(argv.slice(1));
    await runLinuxPart(part.dir, part.program, part.args);
    return;
  }
  const { dir, name, priority, where, now, requestId, routeReason, program, args } =
    parseHeavyArgs(argv);
  if (program === undefined) {
    process.stderr.write(
      "Usage: t3 heavy [--name <title>] [--priority high|low] [--runner mac|linux|automatic] [--now] [--queue-dir <dir>] -- <program> [args...]\n",
    );
    process.exit(2);
  }
  const launch = heavyLaunch(
    { program, args, where },
    process.cwd(),
    NodeOS.homedir(),
    (cwd) => modeFor(readDoc(dir), cwd),
    process.env[HEAVY_JOB_ENV] === "1",
  );
  if (launch.kind === "direct" || !enterFolder(launch.cwd)) {
    // The shell reports a folder it cannot enter itself, as it would without T3.
    runDirect(program, args, process.env);
    return;
  }
  // A repeated request (same tool call, same agent retry) lands on the same job.
  const id =
    requestId === undefined
      ? NodeCrypto.randomUUID()
      : `req-${NodeCrypto.createHash("sha1").update(requestId).digest("hex").slice(0, 16)}`;
  const threadId = process.env.T3CODE_THREAD_ID ?? null;
  const agent = threadId !== null || process.env.CLAUDECODE === "1";
  const label = labelOf(launch.program, launch.args);
  const line = jobLine(launch.program, launch.args);
  // The scripts it runs travel with the job: the Runner judges them by their text.
  const scripts: Record<string, string | null> = {};
  const readScript = scriptReader(launch.cwd);
  readLine(line, (word) => (scripts[word] = readScript(word)));
  const entry: QueuedEntry = {
    id,
    pid: process.pid,
    threadId,
    label,
    ...(line === label ? {} : { line }),
    ...(name === undefined ? {} : { name }),
    ...(Object.keys(scripts).length === 0 ? {} : { scripts }),
    ...(routeReason === undefined ? {} : { routeReason }),
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    startedAt: null,
    // Agents' jobs wait behind the user's own.
    priority: priority ?? launch.priority ?? (agent ? "low" : "normal"),
    ...(launch.where === undefined ? {} : { where: launch.where }),
    ...(now ? { forced: true } : {}),
  };
  // Another process owns this request's job: wait for it to end and answer with its code. An
  // owner that died without one leaves no result, so this process runs the job itself.
  for (let added = enqueue(dir, entry); added !== "added"; added = enqueue(dir, entry)) {
    if (added !== "attached") process.exit(added.code);
    while (readDoc(dir).entries.some((each) => each.id === id)) await pause(POLL_MS);
  }
  // The code a failure notice reports; every exit path ends here.
  process.on("exit", (code) => finish(dir, id, code));

  /** What a signal does right now: exit while waiting, or stop the running attempt. */
  let onSignal: (signal: (typeof SIGNALS)[number]) => void = (signal) =>
    process.exit(WAITING_EXIT[signal]);
  for (const signal of SIGNALS) process.on(signal, () => onSignal(signal));

  const readHost = makeHostReader();
  const environment = process.env;
  while (true) {
    const start = await waitForStart(dir, id, readHost, environment);
    const doc = readDoc(dir);
    const self = doc.entries.find((entry) => entry.id === id);
    const machine = doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG;
    const outcome =
      start.runner === "linux"
        ? await runLinuxAttempt(
            { dir, id, program: launch.program, args: launch.args, machine, environment },
            (handler) => (onSignal = handler),
          )
        : await runMacAttempt(
            {
              dir,
              id,
              program: launch.program,
              args: launch.args,
              workers: start.workers,
              lane: self?.priority,
              environment,
            },
            (handler) => (onSignal = handler),
          );
    if (outcome.kind === "exit") process.exit(outcome.code);
    onSignal = (signal) => process.exit(WAITING_EXIT[signal]);
  }
};

const waitForStart = async (
  dir: string,
  id: string,
  readHost: ReturnType<typeof makeHostReader>,
  environment: NodeJS.ProcessEnv,
) => {
  let lastSampleTry = 0;
  let lastShown = "";
  while (true) {
    if (Date.now() - lastSampleTry >= 2000) {
      lastSampleTry = Date.now();
      recordSampleIfStale(dir, readHost(), SAMPLE_STALE_MS);
      checkLinuxIfStale(dir, environment);
    }
    const start = tryStart(dir, id);
    if (start.status === "removed") {
      process.stderr.write("Removed from the heavy queue by the user.\n");
      process.exit(125);
    }
    if (start.status === "canceled") {
      process.stderr.write(`[t3 heavy] ${start.reason}.\n`);
      process.exit(LINUX_UNAVAILABLE_EXIT);
    }
    if (start.status === "started") {
      if (start.reason !== undefined) process.stderr.write(`[t3 heavy] ${start.reason}.\n`);
      return start;
    }
    const shown = `${start.position}|${start.running?.id ?? ""}|${start.runner ?? ""}|${start.paused ?? ""}|${start.reason ?? ""}`;
    if (shown !== lastShown) {
      lastShown = shown;
      process.stderr.write(
        `[t3 heavy] waiting${start.runner === undefined ? "" : ` on ${runnerName(start.runner)}`}: position ${start.position}${start.running ? ` (running: ${start.running.label})` : ""}${start.paused ? " (queue paused)" : ""}${start.reason ? `: ${start.reason}` : ""}${start.reason?.includes("your answer") ? " (answer in T3's Resource Manager)" : ""}\n`,
      );
    }
    await pause(POLL_MS);
  }
};

/** `remoto`'s own code for "the PC is unreachable"; also what a canceled question exits with. */
const LINUX_UNAVAILABLE_EXIT = 75;

let healthCheckRunning = false;
/** A waiter checks Linux itself when no server's heartbeat is fresh, so the CLI works alone. */
const checkLinuxIfStale = (dir: string, environment: NodeJS.ProcessEnv) => {
  if (healthCheckRunning) return;
  const doc = readDoc(dir);
  const config = configFor(doc, process.cwd());
  const machine = doc.runner?.machine;
  if (!config.runnerEnabled || machine === undefined) return;
  const staleMs = (machine.runnerHeartbeatSeconds + machine.runnerSshTimeoutSeconds) * 1000;
  if (!claimHealthCheck(dir, staleMs)) return;
  healthCheckRunning = true;
  void checkLinux(linkMachine(machine, doc.sample), environment)
    .then(async (check) => {
      recordHealth(dir, check);
      if (check.ok && readDoc(dir).lostRuns.length > 0) {
        await drainLostRuns(dir, machine, environment);
      }
    })
    .catch(logCheckFailure)
    .finally(() => {
      healthCheckRunning = false;
    });
};

/** A heartbeat's own failure is only noted: it never ends the command waiting beside it. */
const logCheckFailure = (error: unknown) => {
  process.stderr.write(`[t3 heavy] Linux check failed: ${String(error)}\n`);
};

/**
 * A run lost the link: one heartbeat now says whether Linux is down, instead of the run. Jobs that
 * lost it together share that one check, so they count as one failure.
 */
const checkLinuxNow = (dir: string, environment: NodeJS.ProcessEnv) => {
  const doc = readDoc(dir);
  const machine = doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG;
  if (!claimHealthCheck(dir, (machine.runnerHeartbeatSeconds * 1000) / 2)) return;
  healthCheckRunning = true;
  void checkLinux(linkMachine(machine, doc.sample), environment)
    .then((check) => recordHealth(dir, check))
    .catch(logCheckFailure)
    .finally(() => {
      healthCheckRunning = false;
    });
};

/** Its runs that lost the link so far, this one included. */
const linkFailuresOf = (dir: string, id: string) =>
  ((readDoc(dir).entries.find((entry) => entry.id === id) as QueuedEntry | undefined)
    ?.linkFailures ?? 0) + 1;

type Attempt = { readonly kind: "exit"; readonly code: number } | { readonly kind: "requeued" };
type SignalHook = (handler: (signal: (typeof SIGNALS)[number]) => void) => void;

const requeueOf = (dir: string, id: string) =>
  readDoc(dir).entries.find((entry) => entry.id === id)?.requeue;

const runMacAttempt = async (
  job: {
    readonly dir: string;
    readonly id: string;
    readonly program: string;
    readonly args: ReadonlyArray<string>;
    readonly workers: number | null;
    readonly lane: "low" | "normal" | "high" | undefined;
    readonly environment: NodeJS.ProcessEnv;
  },
  setSignal: SignalHook,
): Promise<Attempt> => {
  // Ungated (queue off) jobs keep their own worker counts and CPU priority.
  const run =
    job.workers === null
      ? { args: job.args, env: { ...job.environment, [HEAVY_JOB_ENV]: "1" } }
      : withWorkers(job.program, job.args, job.workers, job.environment, {
          cwd: process.cwd(),
          read: readText,
        });
  const launch = launchOf(
    job.program,
    run.args,
    job.workers !== null && AGENT_JOB_CPU === "background" && job.lane === "low",
    // oxlint-disable-next-line t3code/no-global-process-runtime -- The CLI fast path runs before any Effect runtime.
    NodeOS.platform(),
  );
  // Queue off leaves CPU priority alone, so there is nothing for a row to show or change.
  if (job.workers !== null && launch.qos !== null) setQos(job.dir, job.id, launch.qos);
  const child = NodeChildProcess.spawn(launch.program, launch.args, {
    stdio: "inherit",
    env: run.env,
  });
  setSignal((signal) => child.kill(signal));
  let moved: "mac" | "linux" | undefined;
  const watch = setInterval(() => {
    const requeue = requeueOf(job.dir, job.id);
    if (requeue === undefined || moved !== undefined) return;
    moved = requeue;
    child.kill("SIGTERM");
  }, POLL_MS);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("error", (error) => {
        process.stderr.write(`[t3 heavy] cannot run ${job.program}: ${error.message}\n`);
        resolve({ code: 127, signal: null });
      });
      child.on("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  clearInterval(watch);
  if (moved === undefined) return { kind: "exit", code: exitCodeOf(exit.code, exit.signal) };
  process.stderr.write(`[t3 heavy] moved by the user; waiting to run on ${runnerName(moved)}.\n`);
  requeue(job.dir, job.id, { route: moved });
  return { kind: "requeued" };
};

const PHASE_LABEL = { syncing: "syncing", installing: "installing deps", running: "running" };

const runnerName = (runner: "mac" | "linux") => (runner === "linux" ? "Linux" : "this Mac");

const LINUX_JOB_ENV = "T3CODE_HEAVY_LINUX_JOB";

/** Where a work part tells its job that Linux never ran it, or dropped it. */
const outcomePath = (dir: string, id: string) => NodePath.join(dir, `linux-${id}.json`);

/** Linux never ran a part or dropped it, couldn't run it, or it turned out to need this Mac. */
type PartOutcome =
  | RemoteOutcome
  | { readonly kind: "mac"; readonly reason: string }
  /** `code`: Linux's own exit code for it, when it ran there (126, 127). */
  | { readonly kind: "environment"; readonly reason: string; readonly code?: number }
  /** The worktree's own files broke the install there; `reason` is the fix. */
  | { readonly kind: "worktree"; readonly reason: string };

const takeOutcome = (dir: string, id: string): PartOutcome | null => {
  try {
    return JSON.parse(NodeFS.readFileSync(outcomePath(dir, id), "utf8")) as PartOutcome;
  } catch {
    return null;
  } finally {
    NodeFS.rmSync(outcomePath(dir, id), { force: true });
  }
};

/** The run a work part last started there, as it recorded it on the entry. */
const remoteOf = (dir: string, id: string) => {
  const remote = readDoc(dir).entries.find((entry) => entry.id === id)?.remote;
  return remote === undefined ? null : { id: remote.id, pgid: remote.pgid ?? null };
};

/**
 * A Linux job runs its line in a shell here, in a process group of its own: each work part goes
 * to Linux through `t3 heavy linux-part` while redirects, pipes and the rest stay here. A part
 * Linux never ran or dropped ends the group, so the line never carries on past it.
 */
const runLinuxAttempt = async (
  job: {
    readonly dir: string;
    readonly id: string;
    readonly program: string;
    readonly args: ReadonlyArray<string>;
    readonly machine: RunnerMachineConfig;
    readonly environment: NodeJS.ProcessEnv;
  },
  setSignal: SignalHook,
): Promise<Attempt> => {
  const { dir, id, machine, environment } = job;
  const remoto = resolveRemoto(environment);
  if (remoto === null) {
    process.stderr.write("[t3 heavy] remoto is not installed; Linux counts as unavailable.\n");
    recordHealth(dir, { ok: false, error: "remoto is not installed" });
    // This Mac can't reach Linux at all: no link to wait for, so the unavailable policy decides.
    requeue(dir, id, { linuxFailedAt: Date.now(), failure: "remoto is not installed" });
    return { kind: "requeued" };
  }
  takeOutcome(dir, id);
  const { shell, args } = linuxLine(
    job.program,
    job.args,
    selfPrefix(dir, environment, "linux-part"),
  );
  const child = NodeChildProcess.spawn(shell, args, {
    // fd 3 is the job's own stderr, which the line's redirects never touch.
    stdio: ["inherit", "inherit", "inherit", 2],
    detached: true,
    env: { ...environment, [HEAVY_JOB_ENV]: "1", [LINUX_JOB_ENV]: id, T3CODE_REMOTO: remoto },
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`[t3 heavy] cannot run ${shell}: ${error.message}\n`);
      resolve({ code: 127, signal: null });
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const confirmGone = async () => {
    const remote = remoteOf(dir, id);
    return remote === null
      ? true
      : confirmed(await stopRemote(machine, environment, remote.id, remote.pgid));
  };
  let stopping = false;
  setSignal((signal) => {
    if (stopping) return;
    stopping = true;
    signalGroup(signal);
    void exited.then(confirmGone).then((clean) => {
      if (!clean) {
        process.stderr.write(
          "[t3 heavy] stopped here, but Linux could not confirm the run ended there.\n",
        );
      }
      process.exit(WAITING_EXIT[signal]);
    });
  });
  let moved: "mac" | "linux" | undefined;
  const watch = setInterval(() => {
    const requeue = requeueOf(dir, id);
    if (requeue === undefined || moved !== undefined || stopping) return;
    moved = requeue;
    signalGroup("SIGTERM");
  }, POLL_MS);
  const exit = await exited;
  clearInterval(watch);
  if (stopping) return new Promise(() => {});
  const outcome = takeOutcome(dir, id);
  const remote = remoteOf(dir, id);

  if (moved !== undefined) {
    const clean = await confirmGone();
    process.stderr.write(`[t3 heavy] moved by the user; waiting to run on ${runnerName(moved)}.\n`);
    requeue(dir, id, { route: moved, ...(clean ? {} : { unconfirmed: true }) });
    return { kind: "requeued" };
  }
  if (outcome === null || outcome.kind === "finished") {
    return { kind: "exit", code: exitCodeOf(exit.code, exit.signal) };
  }
  if (outcome.kind === "mac") {
    process.stderr.write(`[t3 heavy] ${outcome.reason}; running the line on this Mac.\n`);
    requeue(dir, id, { route: "mac", routeReason: outcome.reason });
    return { kind: "requeued" };
  }
  if (outcome.kind === "worktree") {
    process.stderr.write(`[t3 heavy] ${outcome.reason}\n`);
    setProgress(dir, id, { worktree: outcome.reason });
    return { kind: "exit", code: 1 };
  }
  if (outcome.kind === "environment") {
    // It ended there with its exit code, so nothing is left to confirm.
    process.stderr.write(`[t3 heavy] Linux couldn't run this: ${outcome.reason}\n`);
    if (configFor(readDoc(dir), process.cwd()).runnerDropped === "agent") {
      return { kind: "exit", code: outcome.code ?? LINUX_UNAVAILABLE_EXIT };
    }
    requeue(dir, id, { dropped: true, failure: outcome.reason, linuxFailedAt: Date.now() });
    return { kind: "requeued" };
  }
  if (outcome.kind === "unavailable") {
    process.stderr.write("[t3 heavy] Linux is unavailable; it never started there.\n");
    // A run that got as far as syncing may have a dependency install going there.
    const clean = !outcome.touched || (await confirmGone());
    checkLinuxNow(dir, environment);
    requeue(dir, id, {
      linuxFailedAt: Date.now(),
      linkFailures: linkFailuresOf(dir, id),
      ...(clean ? {} : { unconfirmed: true }),
    });
    return { kind: "requeued" };
  }
  process.stderr.write(
    "[t3 heavy] Linux dropped the connection mid-run; confirming the run stopped there.\n",
  );
  const clean = remote !== null && (await confirmGone());
  checkLinuxNow(dir, environment);
  requeue(dir, id, {
    dropped: true,
    linuxFailedAt: Date.now(),
    linkFailures: linkFailuresOf(dir, id),
    ...(clean ? {} : { unconfirmed: true }),
  });
  return { kind: "requeued" };
};

/**
 * `t3 heavy linux-part -- <program> [args...]`: one work part of a Linux job, run there through
 * `remoto` from this folder, with its output passed through and its progress on the job's entry.
 */
/** Progress for the job's own stderr, outside any redirect the line put on this part. */
const jobNote = (text: string) => {
  try {
    NodeFS.writeSync(3, text);
  } catch {
    // The line closed fd 3: the note is dropped.
  }
};

const runLinuxPart = async (
  dir: string,
  given: string | undefined,
  givenArgs: ReadonlyArray<string>,
) => {
  const id = process.env[LINUX_JOB_ENV];
  const remoto = process.env.T3CODE_REMOTO;
  if (given === undefined || id === undefined || remoto === undefined) {
    process.stderr.write("[t3 heavy] linux-part runs only inside a Linux job.\n");
    process.exit(2);
  }
  const doc = readDoc(dir);
  const home = NodeOS.homedir();
  // The shell has expanded the part by now: what only it knew (`$FILES`, `cd $d`) is plain.
  // A folder it names in another checkout is where it runs: that checkout is the one synced.
  // Its folder and root keep the spelling it used, so its other paths compare alike.
  const moved = movedPart([given, ...givenArgs], process.cwd(), home, (folder) =>
    NodeFS.existsSync(folder) ? gitRootOf(folder) : null,
  );
  const cwd = moved?.cwd ?? process.cwd();
  const [program, ...args] = moved?.values ?? [given, ...givenArgs];
  const root = gitRootOf(cwd);
  if (root === null || program === undefined) {
    return endLine(dir, id, { kind: "mac", reason: `Runs outside a git checkout: ${cwd}` });
  }
  if (needsGit([program, ...args])) return endLine(dir, id, { kind: "mac", reason: NEEDS_GIT });
  // Expanded now, so a program a variable named (`$PY -m pytest`) is judged too.
  const local = programTie([program, ...args], cwd, root, syncedInCopy, scriptReader(cwd));
  if (local !== null) return endLine(dir, id, { kind: "mac", reason: local });
  // A `sh -c` text goes whole: judged again expanded, so it never names a folder Linux lacks.
  const text = shellTextOf([program, ...args]);
  if (text !== undefined) {
    const verdict = bodyVerdict(text, cwd, root, {
      config: configFor(doc, cwd),
      home,
      rootOf: gitRootOf,
      synced: syncedInCopy,
    });
    if (verdict.eligibility === "mac-only" || verdict.eligibility === "exclusive") {
      return endLine(dir, id, { kind: "mac", reason: verdict.reason! });
    }
  }
  const env = args.includes("check:changed") ? changedInputs(args, cwd, root) : [];
  if (env === null) return endLine(dir, id, { kind: "mac", reason: NEEDS_GIT });
  // A script outside the checkout goes as its text: its path does not exist in the Linux copy.
  const script = scriptOf([program, ...args], 0, scriptReader(cwd));
  const tie = args
    .filter((arg) => arg !== script?.word)
    .map((arg) => outsideTie(arg, cwd, root))
    .find((why) => why !== null);
  if (tie !== undefined && tie !== null) return endLine(dir, id, { kind: "mac", reason: tie });
  let command = { program, args };
  if (script !== null && outsideTie(NodePath.resolve(cwd, script.word), cwd, root) !== null) {
    if (script.body === null) return endLine(dir, id, { kind: "mac", reason: UNREADABLE_SCRIPT });
    const rest = script.word === program ? args : args.slice(args.indexOf(script.word) + 1);
    command = { program: "bash", args: ["-c", script.body, script.word, ...rest] };
  }
  let recorded: string | null = null;
  let lastError: string | null = null;
  let unreachable: string | null = null;
  const machine = doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG;
  const bringsBack = configFor(doc, cwd).runnerBringBack;
  /** When the latest run's sync began, on this Mac's clock. */
  let since = 0;
  const fault = (seen: FaultSeen) => {
    const found = faultOf(seen, seen.kind === "exit" ? lastError : (unreachable ?? lastError), {
      command: labelOf(program, args),
      projectFolder: root,
    });
    if (found !== null) recordFault(dir, id, found);
  };
  const start = () => {
    since = Date.now();
    return startLinuxRun({
      remoto,
      program: command.program,
      args: command.args,
      cwd,
      root,
      environment: process.env,
      // `remoto` reads its ssh timeout from `REMOTO_TIMEOUT`, which this sets.
      machine: linkMachine(machine, doc.sample),
      macOnly: configFor(doc, cwd).runnerMacOnly,
      env,
      ...(bringsBack ? { startMarker: id } : {}),
      stdout: (chunk) => process.stdout.write(chunk),
      stderr: (text) => {
        process.stderr.write(text);
        lastError = lastLineOf(text) ?? lastError;
        unreachable ??= unreachableLine(text);
      },
      onProgress: (progress) => {
        if (progress.phase === recorded || progress.phase === null) return;
        recorded = progress.phase;
        jobNote(`[t3 heavy] Linux: ${PHASE_LABEL[progress.phase]}\n`);
        setProgress(dir, id, {
          phase: progress.phase,
          ...(progress.id === null
            ? {}
            : {
                remote: {
                  id: progress.id,
                  ...(progress.pgid === null ? {} : { pgid: progress.pgid }),
                },
              }),
        });
      },
    });
  };
  let run = start();
  // The job stopping or moving signals the whole group; that ends this part without a verdict.
  let stopped = false;
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      stopped = true;
      run.kill(signal);
    });
  }
  let { outcome, progress, platform, install, worktree } = await run.done;
  // An install unfinished in the copy is Linux's, not the code's: once more there, settled now.
  if (!stopped && install !== null && outcome.kind === "finished" && outcome.code !== 0) {
    jobNote(`[t3 heavy] ${INSTALL_FAILED}\n`);
    recorded = null;
    run = start();
    ({ outcome, progress, platform, install, worktree } = await run.done);
    if (!stopped && install !== null && outcome.kind === "finished" && outcome.code !== 0) {
      fault({ kind: "install", package: install });
      return endLine(dir, id, { kind: "environment", reason: INSTALL_FAILED });
    }
  }
  if (stopped) process.exit(143);
  // Rerunning anywhere fails the same way until the worktree is fixed.
  if (outcome.kind !== "finished" && worktree !== null) {
    return endLine(dir, id, { kind: "worktree", reason: worktree });
  }
  if (outcome.kind === "finished") {
    if (bringsBack && progress.id !== null) {
      const back = await bringBack({
        machine: linkMachine(machine, doc.sample),
        environment: process.env,
        copyId: progress.id,
        job: id,
        root,
        since,
      });
      for (const path of back?.skipped ?? []) {
        jobNote(`[t3 heavy] Not copied back (changed on this Mac): ${path}\n`);
      }
    }
    fault({ kind: "exit", code: outcome.code, program: command.program });
    // A tool or file Linux lacks is its environment's failure, which the policy decides.
    const error = lastError as string | null;
    if ((outcome.code === 126 || outcome.code === 127) && error !== null) {
      return endLine(dir, id, { kind: "environment", reason: error, code: outcome.code });
    }
    if (outcome.code !== 0 && platform.length > 0) {
      process.stderr.write(
        `[t3 heavy] This ran on Linux. These failures match the Mac-only list and fail there by nature; run them on this Mac:\n${platform.map((line) => `  ${line}`).join("\n")}\n`,
      );
    }
    process.exit(outcome.code);
  }
  if (outcome.kind === "missing") {
    fault({ kind: "missing", tool: outcome.tool });
    return endLine(dir, id, { kind: "mac", reason: `Not installed on Linux: ${outcome.tool}` });
  }
  // A lost link is retried: it's a fault only once this job has used up its attempts.
  if (linkFailuresOf(dir, id) >= linkAttempts(machine)) {
    fault(
      outcome.kind === "dropped"
        ? { kind: "lost" }
        : outcome.touched
          ? { kind: "sync" }
          : { kind: "unreachable" },
    );
  }
  endLine(dir, id, outcome);
};

/** The last line of Linux's output worth showing: not T3's own notes, not blank. */
const lastLineOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "" && !line.startsWith("[t3 heavy]")) ?? null;

/** Ends the job's process group: nothing after this part runs until the job requeues the line. */
const endLine = (dir: string, id: string, outcome: PartOutcome): never => {
  NodeFS.writeFileSync(outcomePath(dir, id), JSON.stringify(outcome));
  process.kill(0, "SIGTERM");
  process.exit(LINUX_UNAVAILABLE_EXIT);
};
