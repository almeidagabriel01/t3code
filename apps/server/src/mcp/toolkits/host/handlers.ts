// @effect-diagnostics nodeBuiltinImport:off - Free disk space and load average have no Effect API.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";

import * as HostProcess from "@t3tools/shared/HostProcess";
import packageJson from "../../../../package.json" with { type: "json" };
import { ServerConfig } from "../../../config.ts";
import * as ProcessResourceMonitor from "../../../diagnostics/ProcessResourceMonitor.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../../../resourceTelemetry/ResourceTelemetry.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import {
  compactProcessHistory,
  compactResourceHistory,
  countThreads,
  providerStatus,
} from "./model.ts";
import { HostToolkit } from "./tools.ts";

const STATUS_WINDOW_MINUTES = 15;
const HISTORY_BUCKETS = 30;

const freeDisk = (path: string) =>
  Effect.tryPromise(() => NodeFSP.statfs(path)).pipe(
    Effect.map((stats) => ({
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    })),
    Effect.orElseSucceed(() => null),
  );

export const layer = McpToolAccess.toLayer(HostToolkit, {
  t3_host: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { threads } = yield* readCaller();
      if (input.action === "status") {
        const resources = yield* (yield* HostResources.HostResources).read;
        const shells = yield* threads
          .listProjectThreads({ projectId: undefined, includeSubagents: true })
          .pipe(Effect.mapError(unavailable));
        const config = yield* ServerConfig;
        return {
          serverVersion: packageJson.version,
          uptimeSeconds: Math.round(process.uptime()),
          platform: yield* HostProcess.Platform,
          loadAverage: NodeOS.loadavg().map((load) => Math.round(load * 100) / 100),
          cpu: { count: resources.cpuCount, utilization: resources.cpuUtilization },
          memory: {
            totalBytes: resources.totalMemoryBytes,
            availableBytes: resources.availableMemoryBytes,
          },
          disk: yield* freeDisk(config.baseDir),
          ...countThreads(shells),
          providers: providerStatus(yield* (yield* ProviderRegistry.ProviderRegistry).getProviders),
        };
      }
      const windowMs = (input.windowMinutes ?? STATUS_WINDOW_MINUTES) * 60_000;
      const history = { windowMs, bucketMs: Math.ceil(windowMs / HISTORY_BUCKETS) };
      const limit = input.limit ?? 10;
      return input.action === "resources"
        ? compactResourceHistory(
            yield* (yield* ResourceTelemetry.ResourceTelemetry).readHistory(history),
            limit,
          )
        : compactProcessHistory(
            yield* (yield* ProcessResourceMonitor.ProcessResourceMonitor).readHistory(history),
            limit,
          );
    }),
  ),
});
