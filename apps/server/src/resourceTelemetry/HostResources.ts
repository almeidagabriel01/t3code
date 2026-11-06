import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

export interface CpuReading {
  readonly idle: number;
  readonly total: number;
  readonly count: number;
  readonly at: number;
}

// Utilization is measured over at least this long, like Activity Monitor, so one busy instant does not read as 100%.
const CPU_MIN_WINDOW_MS = 2_000;
// A baseline older than this is a stale average, not "current load".
export const CPU_MAX_WINDOW_MS = 15_000;

/** Utilization since `baseline`; `next` is the baseline to keep, held back until the window reaches the minimum. */
export function advanceCpuWindow(baseline: CpuReading | null, current: CpuReading) {
  const elapsed = baseline === null ? 0 : current.at - baseline.at;
  if (
    baseline === null ||
    baseline.count !== current.count ||
    elapsed < 0 ||
    elapsed > CPU_MAX_WINDOW_MS
  ) {
    return { utilization: null, next: current };
  }
  const totalDelta = current.total - baseline.total;
  const idleDelta = current.idle - baseline.idle;
  return {
    utilization:
      totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null,
    next: elapsed >= CPU_MIN_WINDOW_MS ? current : baseline,
  };
}

function readCpu(at: number): CpuReading {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length, at };
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat excludes speculative from free; add it once, without overlapping purgeable pages.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  let cpuBaseline: CpuReading | null = null;
  const sample = Effect.fn("HostResources.sample")(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    let cpu = readCpu(now);
    let window = advanceCpuWindow(cpuBaseline, cpu);
    if (window.utilization === null) {
      // First read after start or a long gap: measure briefly now; later reads reuse the kept baseline.
      yield* Effect.sleep("1 second");
      cpu = readCpu(DateTime.toEpochMillis(yield* DateTime.now));
      window = advanceCpuWindow(window.next, cpu);
    }
    cpuBaseline = window.next;
    const cpuUtilization = window.utilization;
    const totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => ""));
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
    } else if (platform === "darwin") {
      const output = yield* spawner
        .string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes;
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

export const layer = Layer.effect(HostResources, make());
