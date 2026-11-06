// @effect-diagnostics nodeBuiltinImport:off - Load average has no Effect API.
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";

import * as HeavyQueue from "../../../heavyQueue/HeavyQueue.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { countThreads } from "../host/model.ts";
import { heavyStatus } from "./model.ts";
import { HeavyToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HeavyToolkit, {
  t3_heavy: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { scope, threads } = yield* readCaller();
      const queue = yield* HeavyQueue.HeavyQueue;
      const resources = yield* (yield* HostResources.HostResources).read;
      const shells = yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: true })
        .pipe(Effect.mapError(unavailable));
      return heavyStatus({
        entries: (yield* queue.state).entries,
        threadId: scope.thread?.threadId,
        load1: NodeOS.loadavg()[0] ?? 0,
        cpuCount: resources.cpuCount,
        availableMemoryBytes: resources.availableMemoryBytes,
        totalMemoryBytes: resources.totalMemoryBytes,
        workingAgents: countThreads(shells).running,
        command: yield* queue.command,
      });
    }),
  ),
});
