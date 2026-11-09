import { expect, it } from "@effect/vitest";
import {
  AssistantError,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as GroupHandlers from "./handlers.ts";
import { GroupToolkit, type GroupParameters } from "./tools.ts";

const threadId = ThreadId.make("assistant:ada:g-0123456789abcdef");

const stored = {
  id: "scheduled-task:r1",
  title: "Monday",
  prompt: "@ada weekly numbers",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00" },
  projectId: "p1",
  threadId: null,
  assistantTeamId: "team-1",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "m" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  nextRunAt: "2030-01-01T09:00:00.000Z",
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

const harness = (options: {
  readonly thread: boolean;
  /** The message that started the member's turn; a group task by default. */
  readonly startedBy?: { readonly id: string; readonly createdBy: string };
  readonly askedByUser?: boolean;
}) =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const record =
      <A>(method: string, result: A) =>
      (input: unknown) => {
        calls.push({ method, input });
        return Effect.succeed(result);
      };
    const startedBy = options.startedBy ?? { id: "group-task:t-1:1", createdBy: "system" };
    const deps = Layer.mergeAll(
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () =>
          Effect.succeed({
            tasks: [stored, { ...stored, id: "scheduled-task:other", assistantTeamId: "team-2" }],
          } as never),
        upsert: (input) => {
          calls.push({ method: "upsert", input });
          return Effect.succeed({ task: { ...stored, ...input } } as never);
        },
        delete: (input) => {
          calls.push({ method: "delete", input });
          return Effect.succeed(input as never);
        },
        runNow: (input) => {
          calls.push({ method: "runNow", input });
          return Effect.succeed({} as never);
        },
      }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "thread:test",
        thread: options.thread
          ? {
              threadId,
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
            }
          : undefined,
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed({
            id,
            projectId: ProjectId.make("p1"),
            title: "Ada · Core",
            deletedAt: null,
            archivedAt: null,
            activeRunId: "run-1",
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: "codex", model: "m" },
            runtimeMode: "full-access",
            interactionMode: "default",
          } as unknown as OrchestrationV2ThreadShell),
        getThreadRecords: () =>
          Effect.succeed({
            runs: [{ id: "run-1", userMessageId: startedBy.id }],
            messages: [startedBy],
          } as never),
      }),
      Layer.mock(AssistantGroups.AssistantGroups)({
        member: {
          routineScope: () =>
            Effect.succeed({
              teamId: "team-1",
              askedByUser: options.askedByUser ?? false,
            } as never),
          history: record("history", {
            messages: [
              {
                id: "m-1",
                seq: 1,
                author: "user",
                assistantId: null,
                authorLabel: null,
                kind: "message",
                text: "hello",
              } as never,
            ],
            hasMore: false,
          }),
          assign: record("assign", { taskId: "t-2", status: "queued" } as never),
          transfer: record("transfer", { taskId: "t-1", status: "queued" } as never),
          reply: (input) => {
            calls.push({ method: "reply", input });
            return input.text === "fail"
              ? Effect.fail(
                  new AssistantError({ reason: "invalid", message: "You cannot ask yourself." }),
                )
              : Effect.succeed({ accepted: true, message: "Asked." });
          },
          cancel: record("cancel", { accepted: true, message: "Cancelled." } as never),
          result: (input) => {
            calls.push({ method: "result", input });
            return Effect.fail(new AssistantError({ reason: "storage", message: "disk" }));
          },
        },
      }),
    );
    const toolkit = yield* GroupToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(GroupHandlers.layer).pipe(Layer.provide(deps)),
      ),
    );
    const call = (input: GroupParameters) =>
      toolkit.handle("t3_group", input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result as Record<string, any>),
        Effect.provide(deps),
      );
    return { call, calls };
  });

it.effect("each action reaches the member tools as the calling group thread", () =>
  Effect.gen(function* () {
    const { call, calls } = yield* harness({ thread: true });
    expect(yield* call({ action: "history", beforeSeq: 9 })).toEqual({
      messages: [
        {
          seq: 1,
          author: "user",
          assistantId: null,
          label: null,
          kind: "message",
          text: "hello",
        },
      ],
      hasMore: false,
    });
    expect(yield* call({ action: "assign", member: "@beto", text: " compare prices " })).toEqual({
      taskId: "t-2",
      status: "queued",
    });
    yield* call({
      action: "assign",
      member: "beto",
      text: "x",
      expectedResult: "done",
      sourceSeqs: [2],
      resources: ["browser"],
    });
    expect(yield* call({ action: "cancel", taskId: "t-2", text: " stop " })).toEqual({
      accepted: true,
      message: "Cancelled.",
    });
    expect(yield* call({ action: "cancel" })).toMatchObject({
      message: "cancel needs `taskId`: the subtask's id.",
    });
    expect(yield* call({ action: "transfer", member: "beto" })).toEqual({
      taskId: "t-1",
      status: "queued",
    });
    expect(yield* call({ action: "reply", seq: 1, text: "which one?" })).toEqual({
      accepted: true,
      message: "Asked.",
    });
    expect(calls).toEqual([
      { method: "history", input: { callerThreadId: threadId, beforeSeq: 9 } },
      {
        method: "assign",
        input: { callerThreadId: threadId, member: "@beto", instruction: "compare prices" },
      },
      {
        method: "assign",
        input: {
          callerThreadId: threadId,
          member: "beto",
          instruction: "x",
          expectedResult: "done",
          sourceSeqs: [2],
          resources: ["browser"],
        },
      },
      { method: "cancel", input: { callerThreadId: threadId, taskId: "t-2", reason: "stop" } },
      { method: "transfer", input: { callerThreadId: threadId, member: "beto", note: "" } },
      { method: "reply", input: { callerThreadId: threadId, seq: 1, text: "which one?" } },
    ]);
  }),
);

it.effect("missing fields and service errors come back as tool failures", () =>
  Effect.gen(function* () {
    const { call, calls } = yield* harness({ thread: true });
    expect(yield* call({ action: "assign", text: "x" })).toMatchObject({
      code: "invalid_request",
      message: "assign needs `member`.",
    });
    expect(yield* call({ action: "assign", member: "beto" })).toMatchObject({
      message: "assign needs `text`: the subtask.",
    });
    expect(yield* call({ action: "transfer" })).toMatchObject({
      message: "transfer needs `member`.",
    });
    expect(yield* call({ action: "reply", text: "x" })).toMatchObject({
      message: "reply needs `seq`: the #number of the member message.",
    });
    expect(yield* call({ action: "reply", seq: 1 })).toMatchObject({
      message: "reply needs `text`: your question.",
    });
    expect(yield* call({ action: "result" })).toMatchObject({
      message: "result needs `text`: your answer.",
    });
    expect(yield* call({ action: "reply", seq: 1, text: "fail" })).toMatchObject({
      code: "invalid_request",
      message: "You cannot ask yourself.",
    });
    expect(yield* call({ action: "result", text: "done" })).toMatchObject({
      code: "orchestration_error",
    });
    expect(calls.map((entry) => entry.method)).toEqual(["reply", "result"]);
  }),
);

it.effect("a client with no calling thread is refused", () =>
  Effect.gen(function* () {
    const { call, calls } = yield* harness({ thread: false });
    expect(yield* call({ action: "result", text: "done" })).toMatchObject({
      code: expect.any(String),
    });
    expect(calls).toEqual([]);
  }),
);

it.effect("routines of the group are listed, and the user's ask lets a member change them", () =>
  Effect.gen(function* () {
    const { call, calls } = yield* harness({ thread: true, askedByUser: true });
    const listed = yield* call({ action: "routines" });
    expect(listed.routines.map((routine: { routineId: string }) => routine.routineId)).toEqual([
      "scheduled-task:r1",
    ]);
    expect(listed.routines[0]).toMatchObject({ enabled: true, maxRuns: null, missedRun: "skip" });
    const created = yield* call({
      action: "routine_save",
      text: "@ada send the weekly numbers",
      at: "09:30",
      weekdays: [1],
      maxRuns: 4,
      missedRun: "once",
    });
    expect(created).toMatchObject({ routineId: "scheduled-task:r1" });
    const paused = yield* call({
      action: "routine_save",
      routineId: "scheduled-task:r1",
      enabled: false,
    });
    expect(paused).toMatchObject({ enabled: false });
    yield* call({ action: "routine_run", routineId: "scheduled-task:r1" });
    yield* call({ action: "routine_delete", routineId: "scheduled-task:r1" });
    const [create, pause] = calls
      .filter((entry) => entry.method === "upsert")
      .map((entry) => entry.input as any);
    expect(create).toMatchObject({
      assistantTeamId: "team-1",
      schedule: { type: "fixed_time", timeOfDay: "09:30", weekdays: [1] },
      maxRuns: 4,
      missedRunPolicy: "once",
      enabled: true,
    });
    expect(create.commandId).toMatch(/^group-routine:/);
    expect(pause).toMatchObject({ id: "scheduled-task:r1", requireExisting: true, enabled: false });
    expect(pause.schedule).toEqual({ type: "fixed_time", timeOfDay: "09:00" });
    expect(calls.map((entry) => entry.method).slice(-2)).toEqual(["runNow", "delete"]);
  }),
);

it.effect("a member refuses to change routines unless the user asked in the group", () =>
  Effect.gen(function* () {
    const { call, calls } = yield* harness({ thread: true, askedByUser: false });
    for (const input of [
      { action: "routine_save", text: "x", everyMinutes: 5 },
      { action: "routine_run", routineId: "scheduled-task:r1" },
      { action: "routine_delete", routineId: "scheduled-task:r1" },
    ] as const) {
      expect(yield* call(input)).toMatchObject({ code: "capability_denied" });
    }
    expect(calls).toEqual([]);
    // Listing is not a change.
    expect(yield* call({ action: "routines" })).toHaveProperty("routines");
  }),
);

it.effect("routine arguments are checked and another group's routine is out of reach", () =>
  Effect.gen(function* () {
    const { call } = yield* harness({ thread: true, askedByUser: true });
    expect(yield* call({ action: "routine_save", everyMinutes: 5 })).toMatchObject({
      message: "routine_save needs `text`.",
    });
    expect(yield* call({ action: "routine_save", text: "x" })).toMatchObject({
      message: "routine_save needs `runAt`, `at` or `everyMinutes`.",
    });
    expect(yield* call({ action: "routine_run" })).toMatchObject({
      message: "routine_run needs `routineId`.",
    });
    expect(yield* call({ action: "routine_delete" })).toMatchObject({
      message: "routine_delete needs `routineId`.",
    });
    expect(
      yield* call({ action: "routine_delete", routineId: "scheduled-task:other" }),
    ).toMatchObject({ code: "invalid_request" });
    expect(
      yield* call({ action: "routine_save", text: "x", runAt: "2031-01-01T10:00:00Z" }),
    ).toMatchObject({ routineId: "scheduled-task:r1" });
  }),
);

it.effect("a routine turn or a user turn outside a task decides who asked", () =>
  Effect.gen(function* () {
    const user = yield* harness({
      thread: true,
      startedBy: { id: "m-1", createdBy: "user" },
    });
    expect(
      yield* user.call({ action: "routine_run", routineId: "scheduled-task:r1" }),
    ).toMatchObject({
      started: true,
    });
  }),
);
