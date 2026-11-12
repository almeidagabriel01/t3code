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

import type { RunnerMachineConfig, RunnerProjectConfig } from "@t3tools/contracts";

import { HEAVY_JOB_ENV, heavyRoute, shellQuote } from "./heavyHook.ts";
import { readMemorySync, swapInRate } from "./hostReader.ts";
import {
  answerBashCall,
  claimHealthCheck,
  configFor,
  confirmStopped,
  defaultQueueDir,
  enqueue,
  modeFor,
  readDoc,
  recordHealth,
  recordSampleIfStale,
  remove,
  requeue,
  setProgress,
  setQos,
  tryStart,
} from "./queueFile.ts";
import { DEFAULT_MACHINE_CONFIG } from "./runner.ts";
import { checkLinux, confirmed, resolveRemoto, startLinuxRun, stopRemote } from "./runnerExec.ts";

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
  const options = ["--queue-dir", "--name", "--priority", "--runner"];
  while (rest[1] !== undefined && options.includes(rest[0]!)) {
    if (rest[0] === "--name") name = rest[1].trim().slice(0, 60) || undefined;
    else if (rest[0] === "--priority") {
      if (rest[1] === "low" || rest[1] === "normal" || rest[1] === "high") priority = rest[1];
    } else if (rest[0] === "--runner") {
      if (rest[1] === "mac" || rest[1] === "linux" || rest[1] === "automatic") where = rest[1];
    } else dir = rest[1];
    rest = rest.slice(2);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  return { dir, name, priority, where, program: rest[0], args: rest.slice(1) };
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

export const runHeavyCli = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (argv[0] === "hook") {
    await runHook(parseHeavyArgs(argv.slice(1)).dir);
    return;
  }
  const { dir, name, priority, where, program, args } = parseHeavyArgs(argv);
  if (program === undefined) {
    process.stderr.write(
      "Usage: t3 heavy [--name <title>] [--priority high|low] [--runner mac|linux|automatic] [--queue-dir <dir>] -- <program> [args...]\n",
    );
    process.exit(2);
  }
  // Inside a queue job the slot is already held; queuing again would wait on itself.
  // With the queue and the Runner both off here, nothing is tracked or routed.
  if (
    process.env[HEAVY_JOB_ENV] === "1" ||
    heavyRoute(modeFor(readDoc(dir), process.cwd())) === "direct"
  ) {
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
    ...(where === undefined ? {} : { where }),
  });
  process.on("exit", () => remove(dir, id));

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
    const config = configFor(doc, process.cwd());
    const machine = doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG;
    const outcome =
      start.runner === "linux"
        ? await runLinuxAttempt(
            { dir, id, program, args, machine, config, environment },
            (handler) => (onSignal = handler),
          )
        : await runMacAttempt(
            { dir, id, program, args, workers: start.workers, lane: self?.priority, environment },
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
    if (start.status === "started") return start;
    const shown = `${start.position}|${start.running?.id ?? ""}|${start.paused ?? ""}|${start.reason ?? ""}`;
    if (shown !== lastShown) {
      lastShown = shown;
      process.stderr.write(
        `[t3 heavy] waiting: position ${start.position}${start.running ? ` (running: ${start.running.label})` : ""}${start.paused ? " (queue paused)" : ""}${start.reason ? `: ${start.reason}` : ""}${start.reason?.includes("your answer") ? " (answer in T3's Resource Manager)" : ""}\n`,
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
  void checkLinux(machine, environment).then((check) => {
    healthCheckRunning = false;
    recordHealth(dir, check);
  });
};

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
      : withWorkers(job.program, job.args, job.workers, job.environment);
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

const runLinuxAttempt = async (
  job: {
    readonly dir: string;
    readonly id: string;
    readonly program: string;
    readonly args: ReadonlyArray<string>;
    readonly machine: RunnerMachineConfig;
    readonly config: RunnerProjectConfig;
    readonly environment: NodeJS.ProcessEnv;
  },
  setSignal: SignalHook,
): Promise<Attempt> => {
  const { dir, id, machine, environment } = job;
  const remoto = resolveRemoto(environment);
  if (remoto === null) {
    process.stderr.write("[t3 heavy] remoto is not installed; Linux counts as unavailable.\n");
    recordHealth(dir, { ok: false, error: "remoto is not installed" });
    requeue(dir, id, { linuxFailedAt: Date.now() });
    return { kind: "requeued" };
  }
  let shownPhase: string | null = null;
  type Remote = { readonly id: string; readonly pgid: number | null };
  // Set from the progress callback; the cast keeps TypeScript from narrowing it to null here.
  let remote = null as Remote | null;
  const run = startLinuxRun({
    remoto,
    program: job.program,
    args: job.args,
    cwd: process.cwd(),
    environment,
    machine,
    macOnly: job.config.runnerMacOnly,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (text) => process.stderr.write(text),
    onProgress: (progress) => {
      if (progress.id !== null) remote = { id: progress.id, pgid: progress.pgid };
      if (progress.phase !== shownPhase && progress.phase !== null) {
        shownPhase = progress.phase;
        process.stderr.write(`[t3 heavy] Linux: ${PHASE_LABEL[progress.phase]}\n`);
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
      }
    },
  });
  /** Ends the local side, then makes sure nothing is left there; false when it cannot tell. */
  const stopEverything = async (signal: NodeJS.Signals) => {
    run.kill(signal);
    await run.done;
    if (remote === null) return true;
    return confirmed(await stopRemote(machine, environment, remote.id, remote.pgid));
  };
  let stopping = false;
  setSignal((signal) => {
    if (stopping) return;
    stopping = true;
    void stopEverything(signal).then((clean) => {
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
    run.kill("SIGTERM");
  }, POLL_MS);
  const result = await run.done;
  clearInterval(watch);
  if (stopping) return new Promise(() => {});

  if (moved !== undefined) {
    const clean =
      remote === null || confirmed(await stopRemote(machine, environment, remote.id, remote.pgid));
    process.stderr.write(`[t3 heavy] moved by the user; waiting to run on ${runnerName(moved)}.\n`);
    requeue(dir, id, { route: moved, ...(clean ? {} : { unconfirmed: true }) });
    if (!clean) await confirmLater(dir, id, machine, environment, remote!);
    return { kind: "requeued" };
  }
  const { outcome } = result;
  if (outcome.kind === "finished") {
    if (outcome.code !== 0 && result.platform.length > 0) {
      process.stderr.write(
        `[t3 heavy] This ran on Linux. These failures match the Mac-only list and fail there by nature; run them on this Mac:\n${result.platform.map((line) => `  ${line}`).join("\n")}\n`,
      );
    }
    return { kind: "exit", code: outcome.code };
  }
  if (outcome.kind === "unavailable") {
    process.stderr.write("[t3 heavy] Linux is unavailable; it never started there.\n");
    // A run that got as far as syncing may have a dependency install going there.
    const clean =
      !outcome.touched || remote === null
        ? true
        : confirmed(await stopRemote(machine, environment, remote.id, remote.pgid));
    recordHealth(dir, { ok: false, error: "remoto could not reach Linux" });
    requeue(dir, id, { linuxFailedAt: Date.now(), ...(clean ? {} : { unconfirmed: true }) });
    if (!clean) await confirmLater(dir, id, machine, environment, remote!);
    return { kind: "requeued" };
  }
  process.stderr.write(
    "[t3 heavy] Linux dropped the connection mid-run; confirming the run stopped there.\n",
  );
  const clean =
    remote === null
      ? false
      : confirmed(await stopRemote(machine, environment, remote.id, remote.pgid));
  requeue(dir, id, {
    dropped: true,
    linuxFailedAt: Date.now(),
    ...(clean ? {} : { unconfirmed: true }),
  });
  if (!clean && remote !== null) await confirmLater(dir, id, machine, environment, remote);
  return { kind: "requeued" };
};

/**
 * Keeps trying, once per heartbeat interval, to confirm a run ended there, so the entry never
 * reruns while it may still be running. The user can force a rerun from T3 meanwhile.
 */
const confirmLater = async (
  dir: string,
  id: string,
  machine: RunnerMachineConfig,
  environment: NodeJS.ProcessEnv,
  remote: { readonly id: string; readonly pgid: number | null },
) => {
  while (readDoc(dir).entries.find((entry) => entry.id === id)?.unconfirmed === true) {
    await pause(machine.runnerHeartbeatSeconds * 1000);
    if (confirmed(await stopRemote(machine, environment, remote.id, remote.pgid))) {
      confirmStopped(dir, id);
      process.stderr.write("[t3 heavy] Linux confirmed the earlier run stopped.\n");
    }
  }
};
