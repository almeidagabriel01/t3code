import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as DecisionHandlers from "./handlers.ts";
import { DecisionToolkit, type DecisionParameters } from "./tools.ts";

const projectId = ProjectId.make("project-a");
const providerInstanceId = ProviderInstanceId.make("codex");

const dependencies = (threadId: ThreadId | undefined) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "thread:test",
      thread:
        threadId === undefined
          ? undefined
          : { threadId, providerSessionId: "session", providerInstanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          projectId,
          title: "Nightly migration",
          deletedAt: null,
          archivedAt: null,
          activeRunId: "run-1",
          providerInstanceId,
          runtimeMode: "full-access",
          interactionMode: "default",
        } as unknown as OrchestrationV2ThreadShell),
      sendToThread: () => Effect.succeed({} as never),
    }),
  ).pipe(
    Layer.provideMerge(
      DecisionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            SqlitePersistence.layerMemory,
            NodeCrypto.layer,
            Layer.mock(ThreadManagement.ThreadManagementService)({
              sendToThread: () => Effect.succeed({} as never),
            }),
          ),
        ),
      ),
    ),
  );

const harness = (threadId: ThreadId | null = ThreadId.make("thread-1")) =>
  Effect.gen(function* () {
    const deps = Layer.succeedContext(yield* Layer.build(dependencies(threadId ?? undefined)));
    const toolkit = yield* DecisionToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(DecisionHandlers.layer).pipe(Layer.provide(deps)),
      ),
    );
    const call = (input: DecisionParameters) =>
      toolkit.handle("t3_decision", input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result as Record<string, any>),
        Effect.provide(deps),
      );
    const decisions = yield* DecisionService.DecisionService.pipe(Effect.provide(deps));
    return { call, decisions };
  });

const question = {
  action: "request",
  title: "Pick a migration strategy",
  options: [{ label: "Online" }, { label: "Offline", consequence: "Needs downtime" }],
  recommended: "online",
} satisfies DecisionParameters;

it.effect("an agent requests a decision without waiting, and a repeat lands on the same one", () =>
  Effect.gen(function* () {
    const { call, decisions } = yield* harness();
    const first = yield* call({ ...question, clientRequestId: "m1" });
    expect(first).toMatchObject({ status: "open" });
    expect(yield* call({ ...question, clientRequestId: "m1" })).toEqual(first);
    // Without an id the same question derives one, so a retry is safe.
    const derived = yield* call(question);
    expect(yield* call(question)).toEqual(derived);

    const stored = yield* decisions.get(first.decisionId);
    expect(stored).toMatchObject({
      fromThreadId: "thread-1",
      threadTitle: "Nightly migration",
      recommended: "o1",
      options: [
        { id: "o1", label: "Online" },
        { id: "o2", consequence: "Needs downtime" },
      ],
    });

    const read = yield* call({ action: "read", decisionId: first.decisionId });
    expect(read).toMatchObject({ title: "Pick a migration strategy", status: "open" });
    const listed = yield* call({ action: "list" });
    expect(listed.decisions).toHaveLength(2);

    yield* decisions.answer({ decisionId: first.decisionId, optionId: "o2" });
    const answered = yield* call({ action: "read", decisionId: first.decisionId });
    expect(answered).toMatchObject({ status: "answered", answer: { optionId: "o2" } });
    const withdrawn = yield* call({ action: "withdraw", decisionId: first.decisionId });
    expect(withdrawn).toMatchObject({ status: "answered" });

    expect(yield* call({ ...question, options: [] })).toMatchObject({ code: "invalid_request" });
    expect(yield* call({ action: "request", options: question.options })).toMatchObject({
      code: "invalid_request",
    });
    expect(yield* call({ ...question, recommended: "nothing" })).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped),
);

it.effect("only the requesting thread withdraws; `all` lists every thread's decisions", () =>
  Effect.gen(function* () {
    const { call, decisions } = yield* harness();
    const mine = yield* call({ ...question, clientRequestId: "m1" });
    const theirs = yield* decisions.request({
      fromThreadId: ThreadId.make("thread-2"),
      projectId,
      threadTitle: "Other",
      clientRequestId: "x",
      title: "Other question",
      context: "",
      options: [{ id: "a", label: "A" }],
    });
    expect((yield* call({ action: "list" })).decisions).toHaveLength(1);
    expect((yield* call({ action: "list", all: true })).decisions).toHaveLength(2);
    expect(yield* call({ action: "withdraw", decisionId: theirs.id })).toMatchObject({
      code: "invalid_request",
    });
    expect(yield* call({ action: "withdraw", decisionId: mine.decisionId })).toMatchObject({
      status: "withdrawn",
    });
    expect(yield* call({ action: "withdraw", decisionId: mine.decisionId })).toMatchObject({
      status: "withdrawn",
    });
  }).pipe(Effect.scoped),
);

it.effect("a caller that is not a thread is refused for every action", () =>
  Effect.gen(function* () {
    const { call } = yield* harness(null);
    for (const input of [
      { ...question, clientRequestId: "m1" },
      { action: "list" },
      { action: "read", decisionId: "d" },
      { action: "withdraw", decisionId: "d" },
    ] as unknown as DecisionParameters[]) {
      expect(yield* call(input)).toMatchObject({ code: expect.any(String) });
      expect((yield* call(input)).decisionId).toBeUndefined();
    }
  }).pipe(Effect.scoped),
);
