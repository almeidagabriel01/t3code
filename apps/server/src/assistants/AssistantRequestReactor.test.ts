import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { AssistantDirectory } from "./AssistantDirectory.ts";
import * as Reactor from "./AssistantRequestReactor.ts";
import { AssistantRequests, layer as requestsLayer } from "./AssistantRequests.ts";

const asker = ThreadId.make("assistant:asker:1");
const helper = ThreadId.make("assistant:helper:1");
const requestId = "message:request-1";

const runEvent = (status: string, userMessageId: string, type = "run.updated") =>
  ({
    type,
    payload: { threadId: helper, userMessageId, status },
  }) as never as OrchestrationV2DomainEvent;

const harness = (failSend = false) => {
  const sends: Array<Record<string, unknown>> = [];
  const layer = Reactor.layer.pipe(
    Layer.provideMerge(requestsLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.empty,
          getThreadShell: () => Effect.succeed({ projectId: ProjectId.make("project:1") } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) =>
            failSend
              ? Effect.fail(new Error("send failed") as never)
              : Effect.sync(() => void sends.push(input as never)).pipe(Effect.as({} as never)),
        }),
        Layer.mock(AssistantDirectory)({
          forThread: () =>
            Effect.succeedSome({
              assistant: { name: "Helper", handle: "helper" } as never,
              current: true,
            }),
        }),
      ),
    ),
  );
  return { sends, layer };
};

const open = Effect.gen(function* () {
  const requests = yield* AssistantRequests;
  yield* requests.open({
    requestId: requestId as never,
    senderThreadId: asker,
    recipientThreadId: helper,
  });
  return requests;
});

it.effect(
  "tells the asker it is blocked once when the recipient's run fails or is cancelled",
  () => {
    const { sends, layer } = harness();
    return Effect.gen(function* () {
      const reactor = yield* Reactor.AssistantRequestReactor;
      yield* open;
      yield* reactor.handle(runEvent("completed", requestId));
      yield* reactor.handle(runEvent("failed", "message:other"));
      assert.equal(sends.length, 0);
      yield* reactor.handle(runEvent("failed", requestId, "run.created"));
      yield* reactor.handle(runEvent("cancelled", requestId));
      assert.equal(sends.length, 1);
      assert.include(sends[0], { threadId: asker, senderThreadId: helper, mode: "queue" });
      assert.equal(sends[0]!.messageId, `assistant-reply:${requestId}`);
      assert.include(sends[0]!.text as string, "Status: blocked");
      assert.include(sends[0]!.text as string, "<t3_reply");
      assert.notInclude(sends[0]!.text as string, "<t3_request");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps the request open when the blocked notice cannot be delivered", () => {
  const { layer } = harness(true);
  return Effect.gen(function* () {
    const reactor = yield* Reactor.AssistantRequestReactor;
    const requests = yield* open;
    yield* reactor.handle(runEvent("failed", requestId));
    assert.equal(
      yield* requests.claimReply({
        requestId,
        recipientThreadId: helper,
        senderThreadId: asker,
      }),
      "claimed",
    );
    assert.isTrue(Option.isNone(yield* requests.claimBlocked(requestId, helper)));
  }).pipe(Effect.provide(layer));
});

it.effect(
  "holds a blocked notice until the whole group answered, then delivers one message",
  () => {
    const { sends, layer } = harness();
    const other = ThreadId.make("assistant:helper2:1");
    return Effect.gen(function* () {
      const reactor = yield* Reactor.AssistantRequestReactor;
      const requests = yield* AssistantRequests;
      for (const [id, recipient] of [
        ["message:g:a", helper],
        ["message:g:b", other],
      ] as const) {
        yield* requests.open({
          requestId: id as never,
          groupId: "message:g" as never,
          senderThreadId: asker,
          recipientThreadId: recipient,
        });
      }
      yield* reactor.handle(runEvent("failed", "message:g:a"));
      assert.equal(sends.length, 0);
      yield* requests.claimReply({
        requestId: "message:g:b",
        recipientThreadId: other,
        senderThreadId: asker,
        text: "Status: done B",
      });
      // The blocked one was claimed first, so the last answer completes the group.
      const outcome = yield* requests.settle("message:g:b");
      assert.equal(outcome.kind, "complete");
      assert.deepEqual(
        outcome.kind === "complete" ? outcome.delivery.entries.map((e) => e.status) : [],
        ["blocked", "answered"],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("sends the grouped notice from the reactor when the blocked run is the last", () => {
  const { sends, layer } = harness();
  const other = ThreadId.make("assistant:helper2:1");
  return Effect.gen(function* () {
    const reactor = yield* Reactor.AssistantRequestReactor;
    const requests = yield* AssistantRequests;
    for (const [id, recipient] of [
      ["message:g:a", helper],
      ["message:g:b", other],
    ] as const) {
      yield* requests.open({
        requestId: id as never,
        groupId: "message:g" as never,
        senderThreadId: asker,
        recipientThreadId: recipient,
      });
    }
    yield* requests.claimReply({
      requestId: "message:g:b",
      recipientThreadId: other,
      senderThreadId: asker,
      text: "Status: done B",
    });
    assert.equal((yield* requests.settle("message:g:b")).kind, "held");
    yield* reactor.handle(runEvent("failed", "message:g:a"));
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.messageId, "assistant-reply:message:g");
    assert.include(sends[0]!.text as string, "Status: done B");
    assert.include(sends[0]!.text as string, 'status="blocked"');
  }).pipe(Effect.provide(layer));
});
