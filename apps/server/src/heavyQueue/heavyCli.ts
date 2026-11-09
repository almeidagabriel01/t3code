// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/** `t3 heavy [--queue-dir <dir>] -- <program> [args...]`: waits for the machine's heavy slot, then runs the program. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { defaultQueueDir, enqueue, recordSampleIfStale, remove, tryStart } from "./queueFile.ts";

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

export const parseHeavyArgs = (args: ReadonlyArray<string>) => {
  let rest = args;
  let dir = defaultQueueDir();
  if (rest[0] === "--queue-dir" && rest[1] !== undefined) {
    dir = rest[1];
    rest = rest.slice(2);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  return { dir, program: rest[0], args: rest.slice(1) };
};

const cpuTimes = () =>
  NodeOS.cpus().reduce(
    (sum, cpu) => {
      const t = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return { idle: sum.idle + cpu.times.idle, total: sum.total + t };
    },
    { idle: 0, total: 0 },
  );

/** Instantaneous CPU from tick deltas between calls (not the load average). */
const makeHostReader = () => {
  let last = cpuTimes();
  return () => {
    const now = cpuTimes();
    const total = now.total - last.total;
    const busy = total > 0 ? 1 - (now.idle - last.idle) / total : 0;
    last = now;
    const cpuCount = NodeOS.cpus().length;
    return {
      at: Date.now(),
      busyCores: busy * cpuCount,
      cpuCount,
      availableMemoryBytes: NodeOS.freemem(),
      totalMemoryBytes: NodeOS.totalmem(),
    };
  };
};

export const runHeavyCli = async (argv: ReadonlyArray<string>): Promise<void> => {
  const { dir, program, args } = parseHeavyArgs(argv);
  if (program === undefined) {
    process.stderr.write("Usage: t3 heavy [--queue-dir <dir>] -- <program> [args...]\n");
    process.exit(2);
  }
  const id = NodeCrypto.randomUUID();
  const label = [program, ...args].join(" ").slice(0, LABEL_CHARS);
  enqueue(dir, {
    id,
    pid: process.pid,
    threadId: process.env.T3CODE_THREAD_ID ?? null,
    label,
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    startedAt: null,
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
    if (start.status === "started") break;
    const shown = `${start.position}|${start.running?.id ?? ""}|${start.paused ?? ""}`;
    if (shown !== lastShown) {
      lastShown = shown;
      process.stderr.write(
        `[t3 heavy] waiting: position ${start.position}${start.running ? ` (running: ${start.running.label})` : ""}${start.paused ? " (queue paused)" : ""}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  child = NodeChildProcess.spawn(program, args, { stdio: "inherit" });
  child.on("error", (error) => {
    process.stderr.write(`[t3 heavy] cannot run ${program}: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? 128 + (signal ? (NodeOS.constants.signals[signal] ?? 0) : 0));
  });
};
