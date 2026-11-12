/**
 * Publishes the machine reading and each running job's peak usage into the queue file, so every
 * waiter decides admission on the same numbers. Reuses the host and process-tree samplers.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HostResources } from "../resourceTelemetry/HostResources.ts";
import { ResourceTelemetry } from "../resourceTelemetry/ResourceTelemetry.ts";
import { childrenByParent, treeUsage } from "./classifyHeavyCommands.ts";
import * as QueueFile from "./queueFile.ts";

const SAMPLE_INTERVAL = "2 seconds";

/** A job is its entry's process and everything beneath it, in cores and resident bytes. */
export const peaksOf = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
) => {
  const children = childrenByParent(processes);
  const peaks: Record<string, { cpu: number; memoryBytes: number }> = {};
  for (const entry of entries) {
    if (entry.startedAt === null) continue;
    const root = processes.find((process) => process.identity.pid === entry.pid);
    if (root === undefined) continue;
    const { cpu, memoryBytes } = treeUsage(root, children);
    peaks[entry.id] = { cpu, memoryBytes };
  }
  return peaks;
};

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
        const snapshot = running
          ? yield* telemetry.refresh.pipe(Effect.catch(() => telemetry.latest))
          : null;
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
            availableMemoryBytes: reading.availableMemoryBytes,
            totalMemoryBytes: reading.totalMemoryBytes,
            pressureLevel: reading.memoryPressureLevel ?? null,
            swapInBytesPerSecond: reading.swapInBytesPerSecond ?? null,
          },
          snapshot === null ? {} : peaksOf(entries, snapshot.processes),
        );
      }).pipe(Effect.ignore);
      yield* tick.pipe(
        Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  );
