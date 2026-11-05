import {
  assistantIdFromThreadId,
  AutonomyWatchId,
  DEFAULT_ASSISTANT_ID,
  OrchestratorMcpFailure,
  type AutonomyError,
  type AutonomyWatch,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import * as AutonomyService from "../../../autonomy/AutonomyService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { type WatchParameters, WatchToolkit } from "./tools.ts";

type Out = Record<string, Schema.Json>;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const failure = (error: AutonomyError) =>
  error.reason === "storage" ? unavailable() : invalid(error.message);

const brief = (watch: AutonomyWatch): Out => ({
  watchId: watch.id,
  title: watch.title,
  assistantId: watch.assistantId,
  event: watch.filter.event,
  ...(watch.filter.projectId === undefined ? {} : { projectId: watch.filter.projectId }),
  ...(watch.filter.threadId === undefined ? {} : { threadId: watch.filter.threadId }),
  ...(watch.filter.prNumber === undefined ? {} : { prNumber: watch.filter.prNumber }),
  instruction: watch.instruction,
  oneShot: watch.oneShot,
  enabled: watch.enabled,
  triggerCount: watch.triggerCount,
  ...(watch.expiresAt === null ? {} : { expiresAt: watch.expiresAt }),
});

const run = Effect.fn("mcp.watch.run")(
  function* (input: WatchParameters) {
    const autonomy = yield* AutonomyService.AutonomyService;
    const context = yield* loadCaller();
    const owner =
      (context.scope.thread === undefined
        ? null
        : assistantIdFromThreadId(context.scope.thread.threadId)) ?? DEFAULT_ASSISTANT_ID;
    const watches = yield* autonomy.listWatches;
    const mine = watches.filter((watch) => watch.assistantId === owner);
    if (input.action === "list") return { watches: mine.map(brief) } satisfies Out;
    if (input.action === "create") {
      const { title, event, instruction } = input;
      if (title === undefined || title.trim() === "" || event === undefined) {
        return yield* invalid("create needs `title` and `event`.");
      }
      const filter = {
        event,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
      };
      // A repeat of the same request lands on the watch it made, so a retry never doubles it.
      // A finished one-shot watch is disabled, and asking again must make a live one.
      const same = mine.find(
        (watch) =>
          watch.enabled &&
          watch.title === title &&
          watch.instruction === (instruction ?? "") &&
          JSON.stringify(watch.filter) === JSON.stringify(filter),
      );
      if (same !== undefined) return brief(same);
      const now = yield* Clock.currentTimeMillis;
      const watch = yield* autonomy.upsertWatch({
        assistantId: owner,
        title,
        filter,
        instruction: instruction ?? "",
        oneShot: input.oneShot ?? true,
        expiresAt:
          input.expiresInMinutes === undefined
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(now + input.expiresInMinutes * 60_000)),
      });
      return brief(watch);
    }
    const id = input.watchId?.trim();
    if (id === undefined || id === "") return yield* invalid(`${input.action} needs \`watchId\`.`);
    if (!mine.some((watch) => watch.id === id)) return yield* invalid("Watch not found.");
    const watchId = AutonomyWatchId.make(id);
    if (input.action === "delete") {
      yield* autonomy.deleteWatch({ id: watchId });
      return { watchId, deleted: true } satisfies Out;
    }
    return brief(
      yield* autonomy.setWatchEnabled({ id: watchId, enabled: input.action === "resume" }),
    );
  },
  Effect.catchTags({ AutonomyError: (error) => Effect.fail(failure(error)) }),
);

export const layer = McpToolAccess.toLayer(WatchToolkit, {
  t3_watch: McpToolAccess.either(
    (input: WatchParameters) => input.action === "list",
    McpToolAccess.readsAsCaller(run),
    McpToolAccess.actsAsCaller(run),
  ),
});
