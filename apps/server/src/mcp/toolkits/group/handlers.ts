// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hash.
import * as NodeCrypto from "node:crypto";

import {
  type AssistantError,
  CommandId,
  OrchestratorMcpFailure,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { requireUserAskedInGroup } from "../../turnOrigin.ts";
import { type GroupParameters, GroupToolkit } from "./tools.ts";

type Out = Record<string, Schema.Json>;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const failure = (error: AssistantError) =>
  error.reason === "storage" ? unavailable() : invalid(error.message);

const need = (value: string | undefined, message: string) =>
  value === undefined || value.trim() === ""
    ? Effect.fail(invalid(message))
    : Effect.succeed(value.trim());

const routineView = (task: ScheduledTask): Out => ({
  routineId: task.id,
  title: task.title,
  text: task.prompt,
  enabled: task.enabled,
  schedule: task.schedule as Schema.Json,
  nextRunAt: task.nextRunAt,
  lastRunAt: task.lastRunAt,
  lastRunStatus: task.lastRunStatus,
  lastRunError: task.lastRunError,
  runCount: task.runCount,
  maxRuns: task.maxRuns ?? null,
  missedRun: task.missedRunPolicy ?? "skip",
});

const scheduleOf = (input: GroupParameters): ScheduledTaskUpsertInput["schedule"] | undefined =>
  input.runAt !== undefined
    ? { type: "once", runAt: input.runAt }
    : input.at !== undefined
      ? {
          type: "fixed_time",
          timeOfDay: input.at,
          ...(input.weekdays === undefined ? {} : { weekdays: input.weekdays }),
        }
      : input.everyMinutes !== undefined
        ? { type: "interval", everyMs: input.everyMinutes * 60_000 }
        : undefined;

const routine = Effect.fn("mcp.group.routine")(function* (input: GroupParameters) {
  const groups = yield* AssistantGroups.AssistantGroups;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const full = yield* loadCaller();
  const { caller } = full;
  if (caller === undefined) return yield* invalid("This tool only works inside a group task.");
  if (input.action !== "routines") yield* requireUserAskedInGroup(full, "change a group routine");
  const { teamId } = yield* groups.member
    .routineScope({ callerThreadId: caller.id })
    .pipe(Effect.mapError(failure));
  const { tasks } = yield* scheduled.list().pipe(Effect.mapError(() => unavailable()));
  const mine = tasks.filter((task) => task.assistantTeamId === teamId);
  if (input.action === "routines") return { routines: mine.map(routineView) } satisfies Out;
  const existing =
    input.routineId === undefined ? undefined : mine.find((task) => task.id === input.routineId);
  if (input.routineId !== undefined && existing === undefined)
    return yield* invalid("No routine of this group has that routineId. Use `routines`.");
  const taskError = (error: { readonly message: string }) => invalid(error.message);
  if (input.action === "routine_delete") {
    if (existing === undefined) return yield* invalid("routine_delete needs `routineId`.");
    yield* scheduled.delete({ id: existing.id }).pipe(Effect.mapError(taskError));
    return { deleted: true, routineId: existing.id } satisfies Out;
  }
  if (input.action === "routine_run") {
    if (existing === undefined) return yield* invalid("routine_run needs `routineId`.");
    yield* scheduled.runNow({ id: existing.id }).pipe(Effect.mapError(taskError));
    return { started: true, routineId: existing.id } satisfies Out;
  }
  const text = input.text?.trim() || existing?.prompt;
  if (text === undefined || text === "") return yield* invalid("routine_save needs `text`.");
  const schedule =
    scheduleOf(input) ??
    (existing === undefined || existing.schedule.type === "webhook"
      ? undefined
      : existing.schedule);
  if (schedule === undefined)
    return yield* invalid("routine_save needs `runAt`, `at` or `everyMinutes`.");
  const title =
    input.title?.trim() ||
    existing?.title ||
    Array.from(text.split("\n")[0]!).slice(0, 80).join("");
  const key = NodeCrypto.createHash("sha256")
    .update(
      [teamId, existing?.id ?? "", title, text, Object.entries(schedule).join(",")].join("\0"),
    )
    .digest("hex");
  const saved = yield* scheduled
    .upsert({
      ...(existing === undefined
        ? { commandId: CommandId.make(`group-routine:${key.slice(0, 32)}`) }
        : { id: ScheduledTaskId.make(existing.id), requireExisting: true }),
      title,
      prompt: text,
      enabled: input.enabled ?? existing?.enabled ?? true,
      schedule,
      projectId: existing?.projectId ?? caller.projectId,
      assistantTeamId: teamId,
      workspaceStrategy: existing?.workspaceStrategy ?? { type: "root" },
      modelSelection: existing?.modelSelection ?? caller.modelSelection,
      runtimeMode: existing?.runtimeMode ?? full.limits.runtimeMode,
      interactionMode: existing?.interactionMode ?? full.limits.interactionMode,
      createdBy: existing?.createdBy ?? "agent",
      creationSource: "mcp",
      ...(input.missedRun === undefined ? {} : { missedRunPolicy: input.missedRun }),
      ...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
    })
    .pipe(Effect.mapError(taskError));
  return routineView(saved.task);
});

const run = Effect.fn("mcp.group.run")(function* (input: GroupParameters) {
  const groups = yield* AssistantGroups.AssistantGroups;
  const { caller } = yield* loadCaller();
  if (caller === undefined) return yield* invalid("This tool only works inside a group task.");
  const callerThreadId = caller.id;
  switch (input.action) {
    case "routines":
    case "routine_save":
    case "routine_run":
    case "routine_delete":
      return yield* routine(input);
    case "history": {
      const page = yield* groups.member
        .history({
          callerThreadId,
          ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
        })
        .pipe(Effect.mapError(failure));
      return {
        messages: page.messages.map((message) => ({
          seq: message.seq,
          author: message.author,
          assistantId: message.assistantId,
          label: message.authorLabel,
          kind: message.kind,
          text: message.text,
        })),
        hasMore: page.hasMore,
      } satisfies Out;
    }
    case "assign": {
      const member = yield* need(input.member, "assign needs `member`.");
      const instruction = yield* need(input.text, "assign needs `text`: the subtask.");
      return yield* groups.member
        .assign({
          callerThreadId,
          member,
          instruction,
          ...(input.expectedResult === undefined ? {} : { expectedResult: input.expectedResult }),
          ...(input.sourceSeqs === undefined ? {} : { sourceSeqs: input.sourceSeqs }),
          ...(input.resources === undefined ? {} : { resources: input.resources }),
        })
        .pipe(Effect.mapError(failure));
    }
    case "transfer": {
      const member = yield* need(input.member, "transfer needs `member`.");
      return yield* groups.member
        .transfer({ callerThreadId, member, note: input.text?.trim() ?? "" })
        .pipe(Effect.mapError(failure));
    }
    case "reply": {
      if (input.seq === undefined)
        return yield* invalid("reply needs `seq`: the #number of the member message.");
      const text = yield* need(input.text, "reply needs `text`: your question.");
      return {
        ...(yield* groups.member
          .reply({ callerThreadId, seq: input.seq, text })
          .pipe(Effect.mapError(failure))),
      };
    }
    case "cancel": {
      const taskId = yield* need(input.taskId, "cancel needs `taskId`: the subtask's id.");
      return {
        ...(yield* groups.member
          .cancel({ callerThreadId, taskId, reason: input.text?.trim() ?? "" })
          .pipe(Effect.mapError(failure))),
      };
    }
    case "result": {
      const text = yield* need(input.text, "result needs `text`: your answer.");
      return {
        ...(yield* groups.member.result({ callerThreadId, text }).pipe(Effect.mapError(failure))),
      };
    }
  }
});

export const layer = McpToolAccess.toLayer(GroupToolkit, {
  t3_group: McpToolAccess.either(
    (input: GroupParameters) => input.action === "history" || input.action === "routines",
    McpToolAccess.readsAsCaller(run),
    McpToolAccess.actsAsCaller(run),
  ),
});
