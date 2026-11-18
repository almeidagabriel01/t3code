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

import type { RunnerMachineConfig, RunnerProjectConfig, RunnerWhere } from "@t3tools/contracts";

import {
  HEAVY_JOB_ENV,
  heavyRoute,
  heavySegment,
  isQueued,
  lineParts,
  readLine,
  scriptOf,
  SHIMMED,
  shellQuote,
  type ReadScript,
} from "./heavyHook.ts";
import { commitRoute } from "./commitHooks.ts";
import {
  appendTail,
  environmentFaultOf,
  type EnvironmentFault,
  errorLineOf,
  faultOf,
  type FaultSeen,
  missingProgramOf,
  notFoundHere,
  startFailureOf,
  unreachableLine,
} from "./heavyNotices.ts";
import { readMemorySync, swapInRate } from "./hostReader.ts";
import {
  addSyncBack,
  answerBashCall,
  claimHealthCheck,
  configFor,
  defaultQueueDir,
  enqueue,
  finish,
  gitRootOf,
  modeFor,
  readDoc,
  recordFault,
  recordHealth,
  recordSampleIfStale,
  remove,
  requeue,
  scriptReader,
  setProgress,
  setQos,
  tryStart,
} from "./queueFile.ts";
import {
  DEFAULT_MACHINE_CONFIG,
  askedLinux,
  eligibilityOf,
  INSTALL_FAILED,
  linkAttempts,
  linkMachine,
  macReasonOf,
  macReasonText,
  movedPart,
  startFolder,
} from "./runner.ts";
import {
  bringBack,
  changedInputs,
  checkLinux,
  confirmed,
  drainLostRuns,
  fileOffset,
  forwardedInput,
  resolveRemoto,
  startLinuxRun,
  stopRemote,
} from "./runnerExec.ts";
import { listensHere } from "./localPorts.ts";
import type { MacReason, QueuedEntry, RemoteOutcome } from "./runner.ts";
import {
  forgetRoutes,
  learnedRoute,
  learnedRoutes,
  recordRouteFault,
  resetRoutes,
  routeFolder,
  routeKey,
} from "./routeMemory.ts";
import { ensureShims, realProgram, withoutShims } from "./shims.ts";

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
  readAt?: (cwd: string) => ReadScript,
): HeavyLaunch => {
  // Inside a queue job the slot is already held; queuing again would wait on itself.
  if (inJob) return { kind: "direct" };
  const job = jobOf(command.program, command.args, cwd, home);
  const mode = modeAt(job.cwd);
  // `--runner linux` queues even then: the queue cancels it with why instead of a Mac run.
  if (
    (heavyRoute(mode) === "direct" || (job.remoto && !mode.runner)) &&
    command.where !== "linux"
  ) {
    return { kind: "direct" };
  }
  // Its heavy work already goes through `t3 heavy` or `remoto` inside: a slot here would only wait.
  if (!job.remoto && isQueued(jobLine(job.program, job.args), readAt?.(job.cwd))) {
    return { kind: "direct" };
  }
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

const BIN_PATH = /(^|\/)node_modules\/\.bin\/([^/]+)$/;

/**
 * A project bin a line names by path (`./node_modules/.bin/vitest`) goes through `call` as is,
 * by `env`: after `nice` or `timeout`, a leading `ELECTRON_RUN_AS_NODE=1` would be the program.
 */
export const callingBins = (line: string, call: string) =>
  readLine(line)
    .parts.flatMap((part) => {
      const word = part.command.words[part.programAt];
      const name = word === undefined ? undefined : BIN_PATH.exec(word.value)?.[2];
      return name !== undefined && SHIMMED.has(name) ? [word!.start] : [];
    })
    .toSorted((a, b) => b - a)
    .reduce((text, at) => `${text.slice(0, at)}/usr/bin/env ${call} -- ${text.slice(at)}`, line);

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
  subcommand?: "linux-part" | "call",
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

/** Runs a program with this process's stdio; its exit code, 127 when it can't start. */
const spawnCode = (program: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  new Promise<number>((resolve) => {
    const child = NodeChildProcess.spawn(program, args, { stdio: "inherit", env });
    child.on("error", (error) => {
      process.stderr.write(
        `[t3 heavy] cannot run ${program}: ${missingProgramOf(program, process.cwd()) ?? error.message}\n`,
      );
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(exitCodeOf(code, signal)));
  });

const runDirect = (program: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  void spawnCode(program, args, env).then((code) => process.exit(code));

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
  if (argv[0] === "routes") {
    runRoutes(argv.slice(1));
    return;
  }
  if (argv[0] === "linux-part" || argv[0] === "call") {
    const part = parseHeavyArgs(argv.slice(1));
    runCall(part.dir, part.program, part.args, argv[0] === "call");
    return;
  }
  const { dir, name, priority, where, now, requestId, routeReason, program, args } =
    parseHeavyArgs(argv);
  if (program === undefined) {
    process.stderr.write(
      "Usage: t3 heavy [--name <title>] [--priority high|low] [--runner mac|linux|automatic] [--now] [--queue-dir <dir>] -- <program> [args...]\n       t3 heavy routes [--forget <key|all>]\n",
    );
    process.exit(2);
  }
  const launch = heavyLaunch(
    { program, args, where },
    process.cwd(),
    NodeOS.homedir(),
    (cwd) => modeFor(readDoc(dir), cwd),
    process.env[HEAVY_JOB_ENV] === "1",
    scriptReader,
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
    ...(process.env[CALL_ENV] === "1"
      ? { call: true }
      : where === "linux"
        ? { linuxOnly: true }
        : {}),
  };
  // Another process owns this request's job: wait for it to end and answer with its code. An
  // owner that died without one leaves no result, so this process runs the job itself.
  for (let added = enqueue(dir, entry); added !== "added"; added = enqueue(dir, entry)) {
    if (added !== "attached") process.exit(added.code);
    while (readDoc(dir).entries.some((each) => each.id === id)) await pause(POLL_MS);
  }
  // The code a failure notice reports; every exit path ends here.
  process.on("exit", (code) => {
    NodeFS.rmSync(envFile(dir, id), { force: true });
    for (const file of partRemoteFiles(dir, id)) NodeFS.rmSync(file, { force: true });
    finish(
      dir,
      id,
      code,
      Date.now(),
      startFailureOf(launch.program, Object.keys(scripts), entry.cwd, code),
      commandFailure,
    );
  });

  /** What a signal does right now: exit while waiting, or stop the running attempt. */
  let onSignal: (signal: (typeof SIGNALS)[number]) => void = (signal) =>
    process.exit(WAITING_EXIT[signal]);
  for (const signal of SIGNALS) process.on(signal, () => onSignal(signal));

  const readHost = makeHostReader();
  const environment = process.env;
  const queuedCall = environment[CALL_ENV] === "1";
  while (true) {
    const start = await waitForStart(
      dir,
      id,
      readHost,
      environment,
      queuedCall && launch.where === "linux",
    );
    if (start === null) {
      // Its parent holds this Mac: run it under that slot rather than wait for a second one.
      runDirect(launch.program, launch.args, { ...environment, [HEAVY_JOB_ENV]: "1" });
      return;
    }
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
              shims: !queuedCall && self !== undefined && reasonedMac(doc, self),
            },
            (handler) => (onSignal = handler),
          );
    if (outcome.kind === "exit") process.exit(outcome.code);
    onSignal = (signal) => process.exit(WAITING_EXIT[signal]);
  }
};

/** On this Mac for a closed-list reason: its other heavy calls may still go to Linux (D3). */
const reasonedMac = (doc: ReturnType<typeof readDoc>, entry: QueuedEntry) => {
  const config = configFor(doc, entry.cwd);
  if (!config.runnerEnabled) return false;
  const { mac } = eligibilityOf(entry, {
    config,
    home: NodeOS.homedir(),
    rootOf: gitRootOf,
    listening: listensHere,
  });
  return mac !== undefined && mac.code !== "pinned";
};

/** Null: `leavesForMac` and the plan sends it to this Mac, so it left the queue. */
const waitForStart = async (
  dir: string,
  id: string,
  readHost: ReturnType<typeof makeHostReader>,
  environment: NodeJS.ProcessEnv,
  leavesForMac: boolean,
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
    if (leavesForMac && start.runner === "mac") {
      process.stderr.write(
        `[t3 heavy] ${start.reason ?? "Sent to this Mac"}; running under the job that called it.\n`,
      );
      remove(dir, id);
      return null;
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

const queuedOf = (dir: string, id: string): QueuedEntry | undefined =>
  readDoc(dir).entries.find((entry) => entry.id === id);

/** Its runs that lost the link so far, this one included. */
const linkFailuresOf = (dir: string, id: string) => (queuedOf(dir, id)?.linkFailures ?? 0) + 1;

/** Why this process's command could not start anywhere, once a check here found out. */
let commandFailure: string | undefined;

type Attempt = { readonly kind: "exit"; readonly code: number } | { readonly kind: "requeued" };
type SignalHook = (handler: (signal: (typeof SIGNALS)[number]) => void) => void;

const requeueOf = (dir: string, id: string) => queuedOf(dir, id)?.requeue;

const runMacAttempt = async (
  job: {
    readonly dir: string;
    readonly id: string;
    readonly program: string;
    readonly args: ReadonlyArray<string>;
    readonly workers: number | null;
    readonly lane: "low" | "normal" | "high" | undefined;
    readonly environment: NodeJS.ProcessEnv;
    readonly shims: boolean;
  },
  setSignal: SignalHook,
): Promise<Attempt> => {
  // Ungated (queue off) jobs keep their own worker counts and CPU priority.
  const counted =
    job.workers === null
      ? { args: job.args, env: { ...job.environment, [HEAVY_JOB_ENV]: "1" } }
      : withWorkers(job.program, job.args, job.workers, job.environment, {
          cwd: process.cwd(),
          read: readText,
        });
  const run = job.shims
    ? withShims(job.dir, job.id, MAC_JOB_ENV, job.program, counted.args, counted.env)
    : counted;
  const launch = launchOf(
    // The job's own program is never its shim: its calls inside are.
    job.shims ? realProgram(job.program, job.environment.PATH) : job.program,
    run.args,
    job.workers !== null && AGENT_JOB_CPU === "background" && job.lane === "low",
    // oxlint-disable-next-line t3code/no-global-process-runtime -- The CLI fast path runs before any Effect runtime.
    NodeOS.platform(),
  );
  // Queue off leaves CPU priority alone, so there is nothing for a row to show or change.
  if (job.workers !== null && launch.qos !== null) setQos(job.dir, job.id, launch.qos);
  // Its own group, so Stop and a move end its calls too, and their queued jobs with them.
  const child = NodeChildProcess.spawn(launch.program, launch.args, {
    stdio: "inherit",
    detached: true,
    env: run.env,
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  setSignal(signalGroup);
  let moved: "mac" | "linux" | undefined;
  const watch = setInterval(() => {
    const requeue = requeueOf(job.dir, job.id);
    if (requeue === undefined || moved !== undefined) return;
    moved = requeue;
    signalGroup("SIGTERM");
  }, POLL_MS);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("error", (error) => {
        process.stderr.write(
          `[t3 heavy] cannot run ${job.program}: ${missingProgramOf(job.program, process.cwd()) ?? error.message}\n`,
        );
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
/** Set when the job's line reads its own stdin (`while read`): its calls then leave a pipe here. */
const LINE_READS_ENV = "T3CODE_HEAVY_LINE_READS";
const READS_STDIN = /(?:^|[\s;&|({!])(?:read|mapfile|readarray)(?=[\s;&|)]|$)/;
const MAC_JOB_ENV = "T3CODE_HEAVY_MAC_JOB";
const GROUP_ENV = "T3CODE_HEAVY_GROUP";
/** On a job a heavy call queued: its program never goes through the shims again. */
const CALL_ENV = "T3CODE_HEAVY_CALL";
/** What the queuing job's line set for that call, by name: Linux gets them as `env` words. */
const CALL_KEYS_ENV = "T3CODE_HEAVY_CALL_KEYS";

/** The environment a job gave its line, as hashes: a call sends only what the line set. */
const envFile = (dir: string, id: string) => NodePath.join(dir, `env-${id}.json`);
const hashOf = (value: string) => NodeCrypto.createHash("sha1").update(value).digest("hex");
/** Set by shells, git hooks, package runners and T3: never something the line asked a call for. */
const OWN_ENV =
  /^(PATH|PWD|OLDPWD|SHLVL|_|ELECTRON_RUN_AS_NODE|INIT_CWD|GIT_\w+|npm_\w+|PNPM_\w+|T3CODE_HEAVY_\w+)$/;

/**
 * The line as written with the shims first on PATH, and the project bins it names by path sent
 * through `call`; `idEnv` tells each call which job it is in.
 */
const withShims = (
  dir: string,
  id: string,
  idEnv: string,
  program: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) => {
  const call = selfPrefix(dir, environment, "call");
  const env = {
    ...environment,
    PATH: `${ensureShims(dir, call)}:${environment.PATH ?? ""}`,
    [idEnv]: id,
    ...(isShellLine(program, args) && READS_STDIN.test(args[1]!) ? { [LINE_READS_ENV]: "1" } : {}),
  };
  NodeFS.writeFileSync(
    envFile(dir, id),
    JSON.stringify(
      Object.fromEntries(Object.entries(env).map(([key, value]) => [key, hashOf(value ?? "")])),
    ),
    { mode: 0o600 },
  );
  return {
    args: isShellLine(program, args)
      ? [args[0]!, callingBins(args[1]!, call), ...args.slice(2)]
      : args,
    env,
  };
};

/** The variables the line set for this call since its job began (`A=1 vp test`). */
const lineKeys = (dir: string, id: string) => {
  let base: Record<string, string>;
  try {
    base = JSON.parse(NodeFS.readFileSync(envFile(dir, id), "utf8")) as Record<string, string>;
  } catch {
    return [];
  }
  return Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || OWN_ENV.test(key) || base[key] === hashOf(value) ? [] : [key],
  );
};

/**
 * `NAME=value` pairs for what the line set for this call, here or in the job that queued it. They
 * travel on the run's stdin (`envHeader`), never in argv.
 */
const lineEnv = (dir: string, id: string) =>
  [...new Set([...lineKeys(dir, id), ...(process.env[CALL_KEYS_ENV]?.split(" ") ?? [])])]
    .filter((key) => key !== "")
    .map((key) => `${key}=${process.env[key] ?? ""}`);

/** Where a work part tells its job that Linux never ran it, or dropped it. */
const outcomePath = (dir: string, id: string) => NodePath.join(dir, `linux-${id}.json`);

/** Linux never ran a part or dropped it, or the part can't run anywhere as it is. */
type PartOutcome =
  | RemoteOutcome
  /** The worktree's own files broke the install there; `reason` is the fix. */
  | { readonly kind: "worktree"; readonly reason: string }
  /** Not even this Mac finds its program: the command is wrong, wherever it runs. */
  | { readonly kind: "command"; readonly reason: string }
  /** Its job asked for Linux, and Linux can't run this part: the job ends with `code`. */
  | { readonly kind: "refused"; readonly reason: string; readonly code: number };

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

/** Each work part's own run there, until it ends: parallel parts of one job run at once. */
const partRemotePath = (dir: string, id: string) =>
  NodePath.join(dir, `remote-${id}-${process.pid}.json`);

const partRemoteFiles = (dir: string, id: string) => {
  try {
    return NodeFS.readdirSync(dir)
      .filter((name) => name.startsWith(`remote-${id}-`) && name.endsWith(".json"))
      .map((name) => NodePath.join(dir, name));
  } catch {
    return [];
  }
};

/**
 * A Linux job runs its line in a shell here, in a process group of its own: each heavy call goes
 * to Linux through its shim while redirects, pipes and the rest stay here. A call Linux never ran
 * or dropped ends the group, so the line never carries on past it.
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
  // A shell line runs here as written, its heavy calls through the shims. A program alone, or a
  // line read in full with no heavy call to pick out, is itself the work.
  const read = isShellLine(job.program, job.args)
    ? readLine(job.args[1]!, scriptReader(process.cwd()))
    : null;
  const line = read !== null && (read.unsafe !== null || read.parts.some((part) => part.heavy));
  const shell = line ? job.program : "/bin/sh";
  const run = withShims(
    dir,
    id,
    LINUX_JOB_ENV,
    shell,
    line
      ? job.args
      : [
          "-c",
          `${selfPrefix(dir, environment, "linux-part")} -- ${[job.program, ...job.args].map(shellQuote).join(" ")}`,
        ],
    { ...environment, [HEAVY_JOB_ENV]: "1", T3CODE_REMOTO: remoto },
  );
  // Its own group, named for calls inside `timeout`, which starts a group of its own.
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", `export ${GROUP_ENV}=$$; exec "$@"`, "sh", shell, ...run.args],
    {
      // fd 3 is the job's own stderr, which the line's redirects never touch.
      stdio: ["inherit", "inherit", "inherit", 2],
      detached: true,
      env: run.env,
    },
  );
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
  /** Stops every part's run still going there; true once Linux confirms each one ended. */
  const confirmGone = async () => {
    const stop = async (remote: { readonly id: string; readonly pgid: number | null }) =>
      confirmed(await stopRemote(machine, environment, remote.id, remote.pgid));
    const files = partRemoteFiles(dir, id);
    // No call's own record is left: the entry still names the last run there.
    if (files.length === 0) {
      const remote = remoteOf(dir, id);
      return remote === null || (await stop(remote));
    }
    const stops = await Promise.all(
      files.map(async (file) => {
        let remote: { readonly id: string; readonly pgid: number | null };
        try {
          remote = JSON.parse(NodeFS.readFileSync(file, "utf8")) as typeof remote;
        } catch (error) {
          // Removed since it was listed, its run ended; unreadable, nothing confirms it did.
          return (error as NodeJS.ErrnoException).code === "ENOENT";
        }
        const gone = await stop(remote);
        if (gone) NodeFS.rmSync(file, { force: true });
        return gone;
      }),
    );
    return stops.every(Boolean);
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
  // Linux ran short of memory or restarted: the queue ends this attempt.
  let ended = false;
  const watch = setInterval(() => {
    if (moved !== undefined || ended || stopping) return;
    const entry = queuedOf(dir, id);
    if (entry?.stop !== undefined) ended = true;
    else if (entry?.requeue !== undefined) moved = entry.requeue;
    else return;
    signalGroup("SIGTERM");
  }, POLL_MS);
  const exit = await exited;
  clearInterval(watch);
  if (stopping) return new Promise(() => {});
  const outcome = takeOutcome(dir, id);
  const remote = remoteOf(dir, id);

  if (ended) {
    // Read again: a restart seen since a memory stop outranks it.
    const entry = queuedOf(dir, id);
    if (entry?.stop === "reboot") {
      // The boot ended the run: a process group from before it may be someone else's now.
      requeue(dir, id, {
        dropped: true,
        linuxFailedAt: Date.now(),
        linkFailures: linkFailuresOf(dir, id),
      });
      process.stderr.write(
        "[t3 heavy] Linux restarted under this run; it goes back to the queue.\n",
      );
      return { kind: "requeued" };
    }
    const clean = await confirmGone();
    requeue(dir, id, {
      evictedAt: Date.now(),
      evictions: (entry?.evictions ?? 0) + 1,
      ...(clean ? {} : { unconfirmed: true }),
    });
    process.stderr.write(
      "[t3 heavy] Linux ran short of memory: stopped this newest run there; it waits to run again.\n",
    );
    return { kind: "requeued" };
  }
  if (moved !== undefined) {
    const clean = await confirmGone();
    process.stderr.write(`[t3 heavy] moved by the user; waiting to run on ${runnerName(moved)}.\n`);
    requeue(dir, id, { route: moved, ...(clean ? {} : { unconfirmed: true }) });
    return { kind: "requeued" };
  }
  if (outcome === null || outcome.kind === "finished") {
    return { kind: "exit", code: exitCodeOf(exit.code, exit.signal) };
  }
  if (outcome.kind === "command") {
    commandFailure = outcome.reason;
    process.stderr.write(`[t3 heavy] ${outcome.reason}\n`);
    return { kind: "exit", code: 127 };
  }
  if (outcome.kind === "refused") {
    commandFailure = outcome.reason;
    process.stderr.write(`[t3 heavy] ${outcome.reason}.\n`);
    return { kind: "exit", code: outcome.code };
  }
  if (outcome.kind === "worktree") {
    process.stderr.write(`[t3 heavy] ${outcome.reason}\n`);
    setProgress(dir, id, { worktree: outcome.reason });
    return { kind: "exit", code: 1 };
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

/** The route memory's reason to keep this program's calls in this package here, if learned. */
const learnedOf = (
  dir: string,
  command: ReadonlyArray<string>,
  cwd: string,
  root: string,
  config: Pick<RunnerProjectConfig, "runnerRouteMemoryDays" | "runnerRouteLearnAfter">,
): MacReason | null => {
  const found = learnedRoute(
    dir,
    command,
    routeFolder(cwd, root),
    Date.now(),
    config.runnerRouteMemoryDays,
    config.runnerRouteLearnAfter,
  );
  return found === null
    ? null
    : {
        code: "learned",
        subject: `${found.route.line}, ${new Date(found.route.at).toISOString().slice(0, 10)}`,
      };
};

/** Why a call (program first) runs on this Mac: a reason of its own, or a learned route. */
const callMacReason = (
  dir: string,
  values: ReadonlyArray<string>,
  cwd: string,
  root: string,
  config: RunnerProjectConfig,
) =>
  macReasonOf(
    values,
    cwd,
    { config, home: NodeOS.homedir(), rootOf: gitRootOf, listening: listensHere },
    scriptReader(cwd),
  ) ?? learnedOf(dir, values, cwd, root, config);

/** `t3 heavy routes [--forget <key|all>]`: lists or forgets what route memory learned. */
const runRoutes = (args: ReadonlyArray<string>) => {
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : (args[at + 1] ?? "");
  };
  const dir = valueOf("--queue-dir") || defaultQueueDir();
  const forget = valueOf("--forget");
  if (forget === "") {
    process.stderr.write("Usage: t3 heavy routes [--forget <key|all>]\n");
    process.exit(2);
  }
  if (forget !== undefined) {
    process.stdout.write(`Forgot ${forgetRoutes(dir, forget)} route(s).\n`);
    return;
  }
  const routes = learnedRoutes(dir, process.cwd(), Date.now());
  if (routes.length === 0) process.stdout.write("No routes learned.\n");
  for (const route of routes) {
    const state = route.learned
      ? `on this Mac until ${route.expiresAt.slice(0, 10)}`
      : `${route.faults} of ${route.learnAfter} faults, not learned yet`;
    process.stdout.write(`${route.key}\t${state}\t${route.line}\n`);
  }
};

/** Runs a call here as the program it names, past the shims; `strip` keeps its own calls here. */
const runHere = (program: string, args: ReadonlyArray<string>, strip: boolean) => {
  const real = realProgram(program, process.env.PATH);
  // A bare name left unresolved would find its own shim on PATH: shim, call, shim, without end.
  if (!real.includes("/")) {
    process.stderr.write(`[t3 heavy] ${program}: not found on this Mac\n`);
    process.exit(127);
  }
  runDirect(
    real,
    args,
    strip ? { ...process.env, PATH: withoutShims(process.env.PATH) } : process.env,
  );
};

/**
 * One call as a job of its own on `where`, from this folder; the job it is in keeps its slot.
 * Resolves with its exit code; the caller exits with it.
 */
const spawnCall = (
  dir: string,
  where: "mac" | "linux",
  values: ReadonlyArray<string>,
  { reason, keys = [] }: { readonly reason?: string; readonly keys?: ReadonlyArray<string> },
) => {
  const env = {
    ...process.env,
    PATH: withoutShims(process.env.PATH),
    [CALL_ENV]: "1",
    [CALL_KEYS_ENV]: keys.join(" "),
    [HEAVY_JOB_ENV]: undefined,
    [LINUX_JOB_ENV]: undefined,
    [MAC_JOB_ENV]: undefined,
  };
  if (reason !== undefined) {
    process.stderr.write(`[t3 heavy] ${reason}; running this call on this Mac.\n`);
  }
  const options = `--runner ${where}${reason === undefined ? "" : ` --route-reason ${shellQuote(reason)}`}`;
  return spawnCode(
    "/bin/sh",
    ["-c", `${selfPrefix(dir, env)} ${options} -- ${values.map(shellQuote).join(" ")}`],
    env,
  );
};

const queueCall = (...args: Parameters<typeof spawnCall>) =>
  void spawnCall(...args).then((code) => process.exit(code));

/**
 * `t3 heavy call -- <program> [args...]`: a heavy program called inside a queue job, through its
 * shim, judged expanded. A light call runs here. In a Linux job it runs on Linux unless it needs
 * this Mac, then as a Mac job of its own; in a Mac job it runs here when it needs this Mac, else
 * as a Linux job of its own. `linux-part` is a Linux job's own program: no light check.
 */
const runCall = (
  dir: string,
  given: string | undefined,
  args: ReadonlyArray<string>,
  light: boolean,
) => {
  const environment = process.env;
  const linuxJob = environment[LINUX_JOB_ENV];
  const macJob = environment[MAC_JOB_ENV];
  if (given === undefined) {
    process.stderr.write("[t3 heavy] call needs a program.\n");
    process.exit(2);
  }
  if (
    environment[HEAVY_JOB_ENV] !== "1" ||
    (linuxJob === undefined && macJob === undefined) ||
    (light && heavySegment(jobLine(given, args)) === null)
  ) {
    return runHere(given, args, false);
  }
  if (linuxJob !== undefined) return void runLinuxPart(dir, given, args, linuxJob);
  const cwd = process.cwd();
  const doc = readDoc(dir);
  const config = configFor(doc, cwd);
  const root = gitRootOf(cwd);
  const mac = root === null || callMacReason(dir, [given, ...args], cwd, root, config) !== null;
  if (mac || !config.runnerEnabled) return runHere(given, args, true);
  queueCall(dir, "linux", [given, ...args], { keys: lineKeys(dir, macJob!) });
};

/** Progress for the job's own stderr, outside any redirect the line put on this part. */
const jobNote = (text: string) => {
  try {
    NodeFS.writeSync(3, text);
  } catch {
    // The line closed fd 3: the note is dropped.
  }
};

/**
 * One heavy call of a Linux job, run there through `remoto` from this folder, with its output
 * passed through and its progress on the job's entry.
 */
const runLinuxPart = async (
  dir: string,
  given: string,
  givenArgs: ReadonlyArray<string>,
  id: string,
) => {
  const remoto = process.env.T3CODE_REMOTO;
  if (remoto === undefined) {
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
  // Asked for Linux: none of its calls runs here, so the job ends with why instead.
  const linuxOnly = doc.entries.some((entry) => entry.id === id && askedLinux(entry));
  const toMac = (reason: string) =>
    linuxOnly
      ? endLine(dir, id, {
          kind: "refused",
          reason: `Asked for Linux, but it needs this Mac: ${reason}`,
          code: LINUX_UNAVAILABLE_EXIT,
        })
      : queueCall(dir, "mac", [given, ...givenArgs], { reason });
  if (root === null || program === undefined) {
    return toMac(macReasonText({ code: "mac-env", subject: cwd }));
  }
  // Only a path is judged here: a bare name may exist on Linux alone (`xvfb-run`).
  const absent = program.includes("/") ? notFoundHere(program, cwd, root) : undefined;
  if (absent !== undefined) return endLine(dir, id, { kind: "command", reason: absent });
  // Expanded now, so what only the shell knew (`$FILES`, `cd $d`) is judged too.
  const config = configFor(doc, cwd);
  const days = config.runnerRouteMemoryDays;
  const here = callMacReason(dir, [program, ...args], cwd, root, config);
  if (here !== null) return toMac(macReasonText(here));
  const env = [
    ...lineEnv(dir, id),
    ...((args.includes("check:changed") ? changedInputs(args, cwd, root) : null) ?? []),
  ];
  // A script outside the checkout goes as its text: its path does not exist in the Linux copy.
  const script = scriptOf([program, ...args], 0, scriptReader(cwd));
  let command = { program, args };
  if (
    script !== null &&
    script.body !== null &&
    !NodePath.resolve(cwd, script.word).startsWith(`${root}/`)
  ) {
    const rest = script.word === program ? args : args.slice(args.indexOf(script.word) + 1);
    command = { program: "bash", args: ["-c", script.body, script.word, ...rest] };
  }
  let recorded: string | null = null;
  let lastError: string | null = null;
  /** The first line naming a failure: what a card quotes when no exit code explains it. */
  let failure: string | null = null;
  let unreachable: string | null = null;
  /** The end of its output, stdout and stderr, to tell what Linux lacked from a failure. */
  let tail = "";
  const machine = doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG;
  const bringsBack = configFor(doc, cwd).runnerBringBack;
  /** When the latest run's sync began, on this Mac's clock. */
  let since = 0;
  // This call's own start marker there: parallel calls of one job each list what they wrote.
  const call = `${id}-${process.pid}`;
  const fault = (seen: FaultSeen) => {
    const found = faultOf(seen, unreachable ?? failure ?? lastError, {
      command: labelOf(program, args),
      projectFolder: root,
    });
    if (found !== null) recordFault(dir, id, found);
  };
  // Its stdin goes as a program here would get it. A file is read in place, never spent; a pipe the
  // line's `read` loop reads stays here unless the call names stdin, or ssh would drain the loop.
  const named = args.some((arg) => arg === "-" || arg.startsWith("--stdin"));
  const stdin = forwardedInput(0) === 0 ? NodeFS.fstatSync(0) : null;
  const inputStart = stdin?.isFile() === true ? fileOffset(0) : null;
  const input =
    inputStart !== null ||
    (stdin !== null && (named || (stdin.isFIFO() && process.env[LINE_READS_ENV] !== "1")))
      ? 0
      : undefined;
  /** Whether Linux took bytes off a pipe it was handed: a rerun would not get them. */
  let spentInput = false;
  /** Whether Linux wrote any of the call's stdout: a pipe after it already holds that. */
  let wroteOutput = false;
  /**
   * What Linux lacked: this call alone runs again here, once. Input it handed Linux is spent, and
   * output it wrote is already downstream, so then the call ends with Linux's code. Only a rerun
   * here that passes confirms the fault was Linux's, and counts toward its learned route.
   */
  const fallBack = async (lacked: EnvironmentFault, code: number) => {
    if (linuxOnly) {
      return endLine(dir, id, {
        kind: "refused",
        reason: `Linux couldn't run this: ${lacked.line}`,
        code,
      });
    }
    if (spentInput || wroteOutput) {
      const spent = spentInput ? "its input went to Linux" : "it already wrote output";
      process.stderr.write(
        `[t3 heavy] Linux couldn't run this: ${lacked.line}; ${spent}, so it does not run again here.\n`,
      );
      process.exit(code);
    }
    const here = await spawnCall(dir, "mac", [given, ...givenArgs], {
      reason: `Linux couldn't run this: ${lacked.line}`,
    });
    const key = routeKey([program, ...args], routeFolder(cwd, root), lacked.kind);
    if (
      here === 0 &&
      recordRouteFault(dir, key, lacked, Date.now(), days, config.runnerRouteLearnAfter).learned
    ) {
      jobNote(
        `[t3 heavy] Learned: ${key} runs on this Mac for ${days} days (\`t3 heavy routes --forget ${shellQuote(key)}\` undoes it).\n`,
      );
    }
    process.exit(here);
  };
  const start = () => {
    since = Date.now();
    tail = "";
    return startLinuxRun({
      remoto,
      program: command.program,
      args: command.args,
      cwd,
      root,
      environment: { ...process.env, PATH: withoutShims(process.env.PATH) },
      // `remoto` reads its ssh timeout from `REMOTO_TIMEOUT`, which this sets.
      machine: linkMachine(machine, doc.sample),
      macOnly: configFor(doc, cwd).runnerMacOnly,
      env,
      ...(bringsBack ? { startMarker: call } : {}),
      ...(input === undefined ? {} : { input }),
      ...(inputStart === null ? {} : { inputStart }),
      stdout: (chunk) => {
        wroteOutput ||= chunk.length > 0;
        process.stdout.write(chunk);
        tail = appendTail(tail, String(chunk));
      },
      stderr: (text) => {
        process.stderr.write(text);
        tail = appendTail(tail, text);
        const lines = errorLineOf(text);
        lastError = lines.last ?? lastError;
        failure ??= lines.failure;
        unreachable ??= unreachableLine(text);
      },
      onProgress: (progress) => {
        if (progress.phase === recorded || progress.phase === null) return;
        recorded = progress.phase;
        if (progress.id !== null) {
          NodeFS.writeFileSync(
            partRemotePath(dir, id),
            JSON.stringify({ id: progress.id, pgid: progress.pgid }),
          );
        }
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
        // Last: whoever reads the note finds the run recorded.
        jobNote(`[t3 heavy] Linux: ${PHASE_LABEL[progress.phase]}\n`);
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
  let { outcome, progress, platform, install, worktree, spentInput: spent } = await run.done;
  spentInput ||= spent;
  // An install unfinished in the copy is Linux's, not the code's: once more there, settled now.
  if (!stopped && install !== null && outcome.kind === "finished" && outcome.code !== 0) {
    // The first run read the input: a rerun would get none.
    if (!spentInput) {
      jobNote(`[t3 heavy] ${INSTALL_FAILED}\n`);
      recorded = null;
      failure = null;
      run = start();
      ({ outcome, progress, platform, install, worktree, spentInput: spent } = await run.done);
      spentInput ||= spent;
    }
    if (!stopped && install !== null && outcome.kind === "finished" && outcome.code !== 0) {
      fault({ kind: "install", package: install });
      return fallBack(
        { kind: "install", subject: install, line: INSTALL_FAILED },
        outcome.code ?? 1,
      );
    }
  }
  if (stopped) process.exit(143);
  // Linux never ran it or dropped it: this call alone goes again, so its line never repeats. On
  // Linux while it answers, then as "If a Linux run fails" (dropped) or "When Linux is offline"
  // (never started) says, for this call alone; a job asked for Linux ends instead. ponytail: "ask"
  // ends the call like "agent": the queue's question belongs to a waiting job, not a running call.
  for (
    let attempt = 1;
    (outcome.kind === "unavailable" || outcome.kind === "dropped") && worktree === null;
    attempt++
  ) {
    const lost = outcome;
    const why = lost.kind === "dropped" ? "Linux dropped it mid-run" : "Linux is unavailable";
    const lostFault: FaultSeen =
      lost.kind === "dropped"
        ? { kind: "lost" }
        : lost.touched
          ? { kind: "sync" }
          : { kind: "unreachable" };
    process.stderr.write(`[t3 heavy] ${why}.\n`);
    // Unconfirmed, it may still run there: the job holds it until Linux confirms, as before.
    if (
      (lost.kind === "dropped" || lost.touched) &&
      (progress.id === null ||
        !confirmed(await stopRemote(machine, process.env, progress.id, progress.pgid)))
    ) {
      if (linkFailuresOf(dir, id) >= linkAttempts(machine)) fault(lostFault);
      return endLine(dir, id, lost);
    }
    NodeFS.rmSync(partRemotePath(dir, id), { force: true });
    if (spentInput || wroteOutput) {
      const spent = spentInput ? "its input went to Linux" : "it already wrote output";
      process.stderr.write(`[t3 heavy] ${why}; ${spent}, so it does not run again.\n`);
      process.exit(LINUX_UNAVAILABLE_EXIT);
    }
    const health = await checkLinux(linkMachine(machine, doc.sample), process.env);
    recordHealth(dir, health);
    if (!health.ok || attempt >= linkAttempts(machine)) {
      fault(lostFault);
      if (linuxOnly) {
        return endLine(dir, id, {
          kind: "refused",
          reason: `Asked for Linux, but ${why}`,
          code: LINUX_UNAVAILABLE_EXIT,
        });
      }
      const policy = lost.kind === "dropped" ? config.runnerDropped : config.runnerUnavailable;
      if (policy === "mac") {
        process.exit(await spawnCall(dir, "mac", [given, ...givenArgs], { reason: why }));
      }
      if (policy !== "wait") {
        process.stderr.write(`[t3 heavy] Linux couldn't run this: ${why}.\n`);
        process.exit(LINUX_UNAVAILABLE_EXIT);
      }
      jobNote(`[t3 heavy] ${why}: waiting for Linux to run this call again.\n`);
      for (let up = health.ok; !up;) {
        await pause(machine.runnerSshTimeoutSeconds * 1000);
        if (stopped) process.exit(143);
        const again = await checkLinux(linkMachine(machine, doc.sample), process.env);
        recordHealth(dir, again);
        up = again.ok;
      }
      attempt = 0;
    }
    recorded = null;
    failure = null;
    run = start();
    ({ outcome, progress, platform, install, worktree, spentInput: spent } = await run.done);
    spentInput ||= spent;
    if (stopped) process.exit(143);
  }
  // Its command ended there: nothing of it is left to stop.
  if (outcome.kind === "finished") NodeFS.rmSync(partRemotePath(dir, id), { force: true });
  // Rerunning anywhere fails the same way until the worktree is fixed.
  if (outcome.kind !== "finished" && worktree !== null) {
    return endLine(dir, id, { kind: "worktree", reason: worktree });
  }
  // The command ran there, whatever its code: what it wrote comes back before anything else.
  if (outcome.kind === "finished" && bringsBack && progress.id !== null) {
    await syncBack(dir, id, {
      machine: linkMachine(machine, doc.sample),
      environment: process.env,
      copyId: progress.id,
      job: call,
      root,
      since,
      exclude: configFor(doc, cwd).runnerBringBackExclude,
      maxBytes: configFor(doc, cwd).runnerBringBackMaxMB * 1024 ** 2,
    });
  }
  if (outcome.kind === "finished") {
    // What Linux lacked is its environment's failure, not the command's.
    const lacked = environmentFaultOf(outcome.code, tail, {
      program: command.program,
      folders: [cwd, root],
    });
    if (lacked !== null) {
      fault({ kind: "environment", fault: lacked });
      return fallBack(lacked, outcome.code);
    }
    if (outcome.code === 0) {
      resetRoutes(dir, [program, ...args], routeFolder(cwd, root), Date.now(), days);
    }
    if (outcome.code !== 0 && platform.length > 0) {
      process.stderr.write(
        `[t3 heavy] This ran on Linux. These failures match the Mac-only list and fail there by nature; run them on this Mac:\n${platform.map((line) => `  ${line}`).join("\n")}\n`,
      );
    }
    process.exit(outcome.code);
  }
  if (outcome.kind === "missing") {
    // Missing on both machines is the command's own fault, not Linux's.
    const nowhere = notFoundHere(outcome.tool, cwd, root);
    if (nowhere !== undefined) return endLine(dir, id, { kind: "command", reason: nowhere });
    fault({ kind: "missing", tool: outcome.tool });
    return fallBack(
      {
        kind: "missing-program",
        subject: outcome.tool,
        line: `Not installed on Linux: ${outcome.tool}`,
      },
      127,
    );
  }
  endLine(dir, id, outcome);
};

/** Brings one call's results back and adds what stayed there to its job; never fails the call. */
const syncBack = async (dir: string, id: string, options: Parameters<typeof bringBack>[0]) => {
  try {
    const back = await bringBack(options);
    if (back === null) jobNote("[t3 heavy] Could not copy this run's results back from Linux.\n");
    for (const path of back?.skipped ?? []) {
      jobNote(`[t3 heavy] Not copied back (changed on this Mac): ${path}\n`);
    }
    for (const path of back?.deleted ?? []) {
      jobNote(`[t3 heavy] Deleted on Linux, kept here: ${path}\n`);
    }
    const overCapMB = back?.overCap == null ? undefined : Math.ceil(back.overCap / 1024 ** 2);
    if (overCapMB !== undefined) {
      jobNote(
        `[t3 heavy] Nothing copied back: ${overCapMB} MB of results is over the ${options.maxBytes / 1024 ** 2} MB cap.\n`,
      );
    }
    addSyncBack(dir, id, {
      copied: back?.copied.length ?? 0,
      skipped: back?.skipped.length ?? 0,
      deleted: back?.deleted.length ?? 0,
      failed: back === null ? 1 : 0,
      ...(overCapMB === undefined ? {} : { overCapMB }),
    });
  } catch (error) {
    jobNote(`[t3 heavy] Could not copy this run's results back from Linux: ${String(error)}\n`);
  }
};

/** Ends the job's process group: nothing after this part runs until the job requeues the line. */
const endLine = (dir: string, id: string, outcome: PartOutcome): never => {
  try {
    // The first part to end the line names why; a parallel one stopped by it adds nothing.
    NodeFS.writeFileSync(outcomePath(dir, id), JSON.stringify(outcome), { flag: "wx" });
  } catch {
    // Another part already ended the line.
  }
  process.kill(-Number(process.env[GROUP_ENV] ?? 0), "SIGTERM");
  process.exit(LINUX_UNAVAILABLE_EXIT);
};
