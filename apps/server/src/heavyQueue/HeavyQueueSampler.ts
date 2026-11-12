/**
 * Publishes the machine reading and each running job's peak usage into the queue file, so every
 * waiter decides admission on the same numbers. Reuses the host and process-tree samplers.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HostResources } from "../resourceTelemetry/HostResources.ts";
import { ResourceTelemetry } from "../resourceTelemetry/ResourceTelemetry.ts";
import { childrenByParent, treeUsage } from "./classifyHeavyCommands.ts";
import { treePids } from "./HeavyQueue.ts";
import * as QueueFile from "./queueFile.ts";

const SAMPLE_INTERVAL = "2 seconds";

/** `footprint -f bytes` output to bytes by pid; a pid it could not read is simply absent. */
export const parseFootprint = (text: string) =>
  new Map(
    [...text.matchAll(/\[(\d+)\]:[^\n]*?Footprint:\s+(\d+)\s+B/g)].map(
      ([, pid, bytes]) => [Number(pid), Number(bytes)] as const,
    ),
  );

/**
 * A job is its entry's process and everything beneath it, in cores and bytes. `footprints`, by
 * entry, replaces resident bytes: under compression RSS shows a fraction of what a job holds.
 */
export const peaksOf = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  footprints: Readonly<Record<string, number>> = {},
) => {
  const children = childrenByParent(processes);
  const peaks: Record<string, { cpu: number; memoryBytes: number }> = {};
  for (const entry of entries) {
    if (entry.startedAt === null) continue;
    const root = processes.find((process) => process.identity.pid === entry.pid);
    const footprint = footprints[entry.id];
    if (root === undefined) {
      if (footprint !== undefined) peaks[entry.id] = { cpu: 0, memoryBytes: footprint };
      continue;
    }
    const { cpu, memoryBytes } = treeUsage(root, children);
    peaks[entry.id] = { cpu, memoryBytes: footprint ?? memoryBytes };
  }
  return peaks;
};

/**
 * What booted simulators and emulators hold beyond their resident pages: compressed or swapped
 * out now, it comes back the moment they are used, so the queue keeps it free.
 */
export const deviceReserve = (
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  footprints: ReadonlyMap<number, number>,
) =>
  processes
    .filter((process) => process.category === "external-device")
    .reduce(
      (sum, process) =>
        sum + Math.max(0, (footprints.get(process.identity.pid) ?? 0) - process.residentBytes),
      0,
    );

const NO_FOOTPRINTS = { jobs: {}, byPid: new Map() } as const;

/**
 * macOS physical footprint of each running `t3 heavy` job's tree (`jobs`, by entry) and of each
 * pid in `devicePids` (`byPid`); empty elsewhere.
 */
export const readFootprints = Effect.fn("HeavyQueueSampler.readFootprints")(
  function* (entries: ReadonlyArray<HeavyQueueEntry>, devicePids: ReadonlyArray<number> = []) {
    const platform = yield* HostProcess.Platform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = (program: string, args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make(program, args, { stdin: "ignore", stderr: "ignore" }))
        .pipe(Effect.timeout("2 seconds"));
    // A server-held slot's pid is T3 itself, whose tree is everything.
    const jobs = entries.filter((entry) => entry.startedAt !== null && entry.server !== true);
    if (platform !== "darwin" || (jobs.length === 0 && devicePids.length === 0)) {
      return NO_FOOTPRINTS;
    }
    const ps = jobs.length === 0 ? "" : yield* output("/bin/ps", ["-axo", "pid=,ppid="]);
    const trees = jobs.map((entry) => [entry.id, treePids(ps, entry.pid)] as const);
    const byPid = parseFootprint(
      yield* output("/usr/bin/footprint", [
        "-f",
        "bytes",
        "--noCategories",
        ...new Set([...trees.flatMap(([, pids]) => pids), ...devicePids].map(String)),
      ]),
    );
    const jobFootprints: Record<string, number> = Object.fromEntries(
      trees.map(([id, pids]) => [id, pids.reduce((sum, pid) => sum + (byPid.get(pid) ?? 0), 0)]),
    );
    return { jobs: jobFootprints, byPid };
  },
  Effect.orElseSucceed(() => NO_FOOTPRINTS),
);

export const layer = (dir: string = QueueFile.defaultQueueDir()) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const host = yield* HostResources;
      const telemetry = yield* ResourceTelemetry;
      const tick = Effect.gen(function* () {
        const entries = QueueFile.read(dir);
        if (entries.length === 0) return;
        const reading = yield* host.read;
        const running = entries.some((entry) => entry.startedAt !== null);
        // Devices live for minutes, so the last snapshot finds them while nothing runs.
        const snapshot = running
          ? yield* telemetry.refresh.pipe(Effect.catch(() => telemetry.latest))
          : yield* telemetry.latest;
        const processes = snapshot?.processes ?? [];
        const footprints = yield* readFootprints(
          entries,
          processes
            .filter((process) => process.category === "external-device")
            .map((process) => process.identity.pid),
        );
        QueueFile.recordSample(
          dir,
          {
            at: yield* Clock.currentTimeMillis,
            // The host reading's short-window utilisation tracks load now; the load average lags a minute.
            busyCores:
              reading.cpuUtilization === null
                ? (NodeOS.loadavg()[0] ?? 0)
                : reading.cpuUtilization * reading.cpuCount,
            cpuCount: reading.cpuCount,
            availableMemoryBytes: Math.max(
              0,
              reading.availableMemoryBytes - deviceReserve(processes, footprints.byPid),
            ),
            totalMemoryBytes: reading.totalMemoryBytes,
            pressureLevel: reading.memoryPressureLevel ?? null,
            swapInBytesPerSecond: reading.swapInBytesPerSecond ?? null,
          },
          running ? peaksOf(entries, processes, footprints.jobs) : {},
        );
      }).pipe(Effect.ignore);
      yield* tick.pipe(
        Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  );
