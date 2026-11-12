import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as HostResources from "./HostResources.ts";
import { advanceCpuWindow, CPU_MAX_WINDOW_MS, type CpuReading } from "./HostResources.ts";

const reading = (at: number, idle: number, total: number, count = 8): CpuReading => ({
  at,
  idle,
  total,
  count,
});

describe("advanceCpuWindow", () => {
  const base = reading(0, 100, 1000);
  it.each([
    ["no baseline", null, reading(5_000, 200, 2000), null, "current"],
    ["5s window, 90% busy", base, reading(5_000, 200, 2000), 0.9, "current"],
    ["under the minimum window keeps the baseline", base, reading(1_000, 150, 1200), 0.75, "base"],
    ["core count changed resets", base, reading(5_000, 200, 2000, 4), null, "current"],
    ["stale baseline resets", base, reading(CPU_MAX_WINDOW_MS + 1, 200, 2000), null, "current"],
    ["no ticks elapsed", base, reading(5_000, 100, 1000), null, "current"],
  ] as const)("%s", (_name, baseline, current, utilization, next) => {
    const result = advanceCpuWindow(baseline, current);
    expect(result.utilization).toBeCloseTo(utilization ?? 0);
    if (utilization === null) expect(result.utilization).toBeNull();
    expect(result.next).toBe(next === "base" ? baseline : current);
  });
});

const vmStat = (swapins: number) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Anonymous pages:                         600000.
Pages purgeable:                          50000.
Pages wired down:                        150000.
Pages occupied by compressor:            200000.
Swapins:                                ${swapins}.
`;

/** Answers `vm_stat` and the pressure sysctl. */
const fakeSpawner = () =>
  ChildProcessSpawner.make((command) => {
    const { command: name } = command as unknown as { command: string };
    const text = name === "/usr/bin/vm_stat" ? vmStat(1_000) : "2\n";
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(text)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

const readAfter = (host: HostResources.HostResources["Service"], wait: string) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(host.read);
    yield* TestClock.adjust(wait);
    return yield* Fiber.join(fiber);
  });

describe("HostResources memory", () => {
  it.effect("on macOS reads pressure and swap-in from vm_stat, not free pages", () =>
    Effect.gen(function* () {
      const host = yield* HostResources.HostResources;
      const first = yield* readAfter(host, "1 second");
      const used = (600_000 - 50_000 + 150_000 + 200_000) * 16_384;
      expect(first).toMatchObject({
        availableMemoryBytes: Math.max(0, first.totalMemoryBytes - used),
        memoryPressureLevel: 2,
      });
      // One reading has no rate yet; `swapInRate` covers the pair.
      expect(first.swapInBytesPerSecond).toBeUndefined();
    }).pipe(
      Effect.provide(
        HostResources.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner()),
              Layer.mock(FileSystem.FileSystem)({}),
            ),
          ),
          Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
        ),
      ),
    ),
  );

  it.effect("on Linux reads MemAvailable and pswpin from /proc", () =>
    Effect.gen(function* () {
      const host = yield* HostResources.HostResources;
      const reading = yield* readAfter(host, "1 second");
      expect(reading.availableMemoryBytes).toBe(
        Math.min(reading.totalMemoryBytes, 1_000_000 * 1024),
      );
      expect(reading.memoryPressureLevel).toBeUndefined();
    }).pipe(
      Effect.provide(
        HostResources.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner()),
              Layer.mock(FileSystem.FileSystem)({
                readFileString: (path: string) =>
                  Effect.succeed(
                    path === "/proc/meminfo" ? "MemAvailable:    1000000 kB\n" : "pswpin 5\n",
                  ),
              }),
            ),
          ),
          Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
        ),
      ),
    ),
  );
});
