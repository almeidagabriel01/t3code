// @effect-diagnostics nodeBuiltinImport:off - Load average and the home folder have no Effect API.
import * as NodeOS from "node:os";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HeavyCommands from "../../../heavyQueue/HeavyCommands.ts";
import * as HeavyQueue from "../../../heavyQueue/HeavyQueue.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { countThreads } from "../host/model.ts";
import { heavyStatus } from "./model.ts";
import { HeavyToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HeavyToolkit, {
  t3_heavy: McpToolAccess.reads(({ action, id, to, commandLine, key }) =>
    Effect.gen(function* () {
      const { scope, threads } = yield* readCaller();
      const queue = yield* HeavyQueue.HeavyQueue;
      const failed = (error: { readonly message: string }) =>
        new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
      if (action === "routes") {
        const cwd =
          scope.thread === undefined
            ? undefined
            : yield* threadWorkspaceRoot(scope.thread.threadId);
        return yield* queue.listRoutes(cwd).pipe(Effect.mapError(failed));
      }
      if (action === "forget_route") {
        yield* McpToolAccess.refuseReadOnlyClient;
        if (key === undefined || key.trim() === "") {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "`forget_route` needs a `key` from `routes`, or `all`.",
          });
        }
        const forgot = yield* queue.forgetRoutes(key.trim()).pipe(Effect.mapError(failed));
        return forgot.removed > 0
          ? forgot
          : { ...forgot, note: "Nothing to forget: no learned route has that key now." };
      }
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
      let moved: ReadonlyArray<string> | undefined;
      if (action === "move_all") {
        yield* McpToolAccess.refuseReadOnlyClient;
        if (to === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "move_all: send every waiting job that can run on `to` (mac or linux) there. Running jobs stay.",
          });
        }
        moved = yield* queue
          .routeAll(to)
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
      const cwd =
        scope.thread === undefined ? undefined : yield* threadWorkspaceRoot(scope.thread.threadId);
      const destination =
        commandLine === undefined || commandLine.trim() === ""
          ? null
          : yield* queue.probe(commandLine, cwd ?? NodeOS.homedir()).pipe(
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            );
      const shells = yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: true })
        .pipe(Effect.mapError(unavailable));
      const status = heavyStatus({
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
        destination,
      });
      if (moved === undefined) return status;
      if (moved.length > 0) return { ...status, moved };
      const note =
        to === "linux" && state.linux === null
          ? "Nothing moved: the Runner is off."
          : to === "linux" && state.linux?.online !== true
            ? "Nothing moved: Linux is unavailable."
            : `Nothing moved: no waiting job can move to ${to === "linux" ? "Linux" : "this Mac"}.`;
      return { ...status, moved, note };
    }),
  ),
});
