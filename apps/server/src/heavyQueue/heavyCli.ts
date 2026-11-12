// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * `t3 heavy [--name <title>] [--priority high|low] [--queue-dir <dir>] -- <program> [args...]`:
 * waits for the machine's heavy slot, then runs the program. `t3 heavy hook` is the Claude Code
 * PreToolUse hook that puts heavy Bash commands behind it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

import { HEAVY_JOB_ENV, interceptBashCall, shellQuote } from "./heavyHook.ts";
import { readMemorySync, swapInRate } from "./hostReader.ts";
import {
  defaultQueueDir,
  enqueue,
  readDoc,
  recordSampleIfStale,
  remove,
  tryStart,
} from "./queueFile.ts";

/**
 * CPU priority an agent's job starts with on macOS; the user's own jobs always run normal.
 * "background" is `taskpolicy -b`. Adopt it only if scripts/heavy-priority-bench.sh shows it
 * within ~15% of normal on a free machine.
 */
const AGENT_JOB_CPU = "normal" as "normal" | "background";

/** The program a job runs as: under `taskpolicy -b` when it starts in the background on macOS. */
export const launchOf = (
  program: string,
  args: ReadonlyArray<string>,
  background: boolean,
  platform: NodeJS.Platform,
) =>
  background && platform === "darwin"
    ? { program: "/usr/sbin/taskpolicy", args: ["-b", program, ...args] }
    : { program, args };

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
  const options = ["--queue-dir", "--name", "--priority"];
  while (rest[1] !== undefined && options.includes(rest[0]!)) {
    if (rest[0] === "--name") name = rest[1].trim().slice(0, 60) || undefined;
    else if (rest[0] === "--priority") {
      if (rest[1] === "low" || rest[1] === "normal" || rest[1] === "high") priority = rest[1];
    } else dir = rest[1];
    rest = rest.slice(2);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  return { dir, name, priority, program: rest[0], args: rest.slice(1) };
};

/** A hook-wrapped `$SHELL -c '<line>'` is labelled by the line itself, so names and history keep it. */
export const labelOf = (program: string, args: ReadonlyArray<string>) =>
  (SHELLS.has(NodePath.basename(program)) && args[0] === "-c" && args[1] !== undefined
    ? args[1]
    : [program, ...args].join(" ")
  ).slice(0, LABEL_CHARS);

/**
 * Runners that size themselves by cores take the admitted count instead: Vitest from the
 * environment, `node --test` and `playwright test` from a flag when they are the program itself.
 */
export const withWorkers = (
  program: string,
  args: ReadonlyArray<string>,
  workers: number,
  environment: NodeJS.ProcessEnv,
) => {
  const name = NodePath.basename(program);
  const has = (flag: string) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const extra =
    name === "node" && has("--test") && !has("--test-concurrency")
      ? [`--test-concurrency=${workers}`]
      : name === "playwright" && args[0] === "test" && !has("--workers") && !has("-j")
        ? [`--workers=${workers}`]
        : [];
  return {
    args: [...args, ...extra],
    env: {
      ...environment,
      [HEAVY_JOB_ENV]: "1",
      T3_HEAVY_WORKERS: String(workers),
      VITEST_MAX_WORKERS: environment.VITEST_MAX_WORKERS ?? String(workers),
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
export const selfPrefix = (dir: string, environment: NodeJS.ProcessEnv = process.env) =>
  [
    ...(environment.ELECTRON_RUN_AS_NODE === "1" ? ["ELECTRON_RUN_AS_NODE=1"] : []),
    shellQuote(process.execPath),
    ...(NodeSea.isSea() || process.argv[1] === undefined
      ? []
      : [shellQuote(NodePath.resolve(process.argv[1]))]),
    "heavy",
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
    const answer = interceptBashCall(
      JSON.parse(await readStdin()),
      selfPrefix(dir),
      readDoc(dir),
      process.env,
    );
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

export const runHeavyCli = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (argv[0] === "hook") {
    await runHook(parseHeavyArgs(argv.slice(1)).dir);
    return;
  }
  const { dir, name, priority, program, args } = parseHeavyArgs(argv);
  if (program === undefined) {
    process.stderr.write(
      "Usage: t3 heavy [--name <title>] [--priority high|low] [--queue-dir <dir>] -- <program> [args...]\n",
    );
    process.exit(2);
  }
  // Inside a queue job the slot is already held; queuing again would wait on itself.
  if (process.env[HEAVY_JOB_ENV] === "1") {
    runDirect(program, args, process.env);
    return;
  }
  const id = NodeCrypto.randomUUID();
  const threadId = process.env.T3CODE_THREAD_ID ?? null;
  const agent = threadId !== null || process.env.CLAUDECODE === "1";
  enqueue(dir, {
    id,
    pid: process.pid,
    threadId,
    label: labelOf(program, args),
    ...(name === undefined ? {} : { name }),
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    startedAt: null,
    // Agents' jobs wait behind the user's own.
    priority: priority ?? (agent ? "low" : "normal"),
  });
  process.on("exit", () => remove(dir, id));

  let child: ReturnType<typeof NodeChildProcess.spawn> | undefined;
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      if (child) child.kill(signal);
      else process.exit(WAITING_EXIT[signal]);
    });
  }

  const readHost = makeHostReader();
  let lastSampleTry = 0;
  let lastShown = "";
  let workers: number;
  while (true) {
    if (Date.now() - lastSampleTry >= 2000) {
      lastSampleTry = Date.now();
      recordSampleIfStale(dir, readHost(), SAMPLE_STALE_MS);
    }
    const start = tryStart(dir, id);
    if (start.status === "removed") {
      process.stderr.write("Removed from the heavy queue by the user.\n");
      process.exit(125);
    }
    if (start.status === "started") {
      workers = start.workers;
      break;
    }
    const shown = `${start.position}|${start.running?.id ?? ""}|${start.paused ?? ""}|${start.reason ?? ""}`;
    if (shown !== lastShown) {
      lastShown = shown;
      process.stderr.write(
        `[t3 heavy] waiting: position ${start.position}${start.running ? ` (running: ${start.running.label})` : ""}${start.paused ? " (queue paused)" : ""}${start.reason ? `: ${start.reason}` : ""}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  const run = withWorkers(program, args, workers, process.env);
  // Read at start: the user may have raised this job while it waited.
  const lane = readDoc(dir).entries.find((entry) => entry.id === id)?.priority;
  const launch = launchOf(
    program,
    run.args,
    AGENT_JOB_CPU === "background" && lane === "low",
    // oxlint-disable-next-line t3code/no-global-process-runtime -- The CLI fast path runs before any Effect runtime.
    NodeOS.platform(),
  );
  child = runDirect(launch.program, launch.args, run.env);
};
