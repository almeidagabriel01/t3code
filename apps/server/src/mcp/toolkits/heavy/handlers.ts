// @effect-diagnostics nodeBuiltinImport:off - Load average has no Effect API.
import * as NodeOS from "node:os";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HeavyCommands from "../../../heavyQueue/HeavyCommands.ts";
import * as HeavyQueue from "../../../heavyQueue/HeavyQueue.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { countThreads } from "../host/model.ts";
import { heavyStatus } from "./model.ts";
import { HeavyToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HeavyToolkit, {
  t3_heavy: McpToolAccess.reads(({ action, id }) =>
    Effect.gen(function* () {
      const { scope, threads } = yield* readCaller();
      const queue = yield* HeavyQueue.HeavyQueue;
      if (action === "promote") {
        yield* McpToolAccess.refuseReadOnlyClient;
        if (id === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "`promote` needs the entry `id` from `status`.",
          });
        }
        yield* queue
          .promote(
            id,
            `Moved up by an agent (thread ${scope.thread?.threadId ?? "unknown"}) at the user's request`,
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
            ),
          );
      }
      const state = yield* queue.state;
      const resources = yield* (yield* HostResources.HostResources).read;
      const running = yield* (yield* HeavyCommands.HeavyCommands).list;
      const shells = yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: true })
        .pipe(Effect.mapError(unavailable));
      return heavyStatus({
        entries: state.entries,
        maxRunning: state.maxRunning,
        enabled: state.enabled,
        room: state.room,
        reasons: state.reasons,
        machine: state.machine,
        linux: state.linux,
        routes: state.routes,
        threadId: scope.thread?.threadId,
        busyCores: state.machine?.busyCores ?? NodeOS.loadavg()[0] ?? 0,
        cpuCount: resources.cpuCount,
        availableMemoryBytes: resources.availableMemoryBytes,
        totalMemoryBytes: resources.totalMemoryBytes,
        workingAgents: countThreads(shells).running,
        command: yield* queue.command,
        commands: running.commands,
      });
    }),
  ),
});
