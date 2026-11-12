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

import {
  type MemoryReading,
  parseDarwinMemory,
  parseLinuxMemory,
  swapInRate,
} from "../heavyQueue/hostReader.ts";

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

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  let cpuBaseline: CpuReading | null = null;
  let lastSwap: { readonly at: number; readonly swapInBytes: number | null } | null = null;
  const output = (command: string, args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" })).pipe(
      Effect.timeout("1 second"),
      Effect.orElseSucceed(() => ""),
    );
  const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
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
    let memory: MemoryReading | null = null;
    if (platform === "linux") {
      memory = parseLinuxMemory(
        yield* readText("/proc/meminfo"),
        yield* readText("/proc/vmstat"),
        totalMemoryBytes,
      );
    } else if (platform === "darwin") {
      const [vmStat, pressure] = yield* Effect.all(
        [
          output("/usr/bin/vm_stat", []),
          output("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
        ],
        { concurrency: 2 },
      );
      memory = parseDarwinMemory(vmStat, pressure, totalMemoryBytes);
    }
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    const availableMemoryBytes = memory?.availableMemoryBytes ?? NodeOS.freemem();
    const swap = { at: cpu.at, swapInBytes: memory?.swapInBytes ?? null };
    const swapInBytesPerSecond = swapInRate(lastSwap, swap);
    lastSwap = swap;
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      ...(memory?.pressureLevel == null ? {} : { memoryPressureLevel: memory.pressureLevel }),
      ...(swapInBytesPerSecond === null ? {} : { swapInBytesPerSecond }),
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
