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
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as GroupHandlers from "./handlers.ts";
import { GroupToolkit, type GroupParameters } from "./tools.ts";

const threadId = ThreadId.make("assistant:ada:g-0123456789abcdef");

const harness = (options: { readonly thread: boolean }) =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const record =
      <A>(method: string, result: A) =>
      (input: unknown) => {
        calls.push({ method, input });
        return Effect.succeed(result);
      };
    const deps = Layer.mergeAll(
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
            runtimeMode: "full-access",
            interactionMode: "default",
          } as unknown as OrchestrationV2ThreadShell),
      }),
      Layer.mock(AssistantGroups.AssistantGroups)({
        member: {
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
