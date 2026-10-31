import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as DecisionService from "../decisions/DecisionService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { AssistantDirectory } from "./AssistantDirectory.ts";
import * as Reactor from "./AssistantApprovalReactor.ts";

const jarvisThread = "assistant:jarvis:1";

interface FakeRequest {
  id: string;
  kind: string;
  status: string;
  responseCapability: { type: string };
}
const live = { type: "live" };

const harness = () => {
  /** What the projection holds, by thread then request id. */
  const requests = new Map<string, FakeRequest>();
  const sends: unknown[] = [];
  const layer = Reactor.layer.pipe(
    Layer.provideMerge(DecisionService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeResponseContext: (threadId, requestId) =>
            Effect.succeed({
              request: requests.get(`${threadId}/${requestId}`),
              item: {
                type: "approval_request",
                prompt: "rm -rf build",
                reason: "Clean the output",
              },
            } as never),
          getThreadRecords: (threadId) =>
            Effect.succeed({
              runtimeRequests: [...requests]
                .filter(([key]) => key.startsWith(`${threadId}/`))
                .map(([, request]) => request),
            } as never),
        }),
        Layer.mock(AssistantDirectory)({
          forThread: (threadId) =>
            Effect.succeed(
              threadId.startsWith("assistant:jarvis:")
                ? Option.some({
                    assistant: { name: "Jarvis", projectId: "scratch" } as never,
                    current: true,
                  })
                : Option.none(),
            ),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) => {
            sends.push(input);
            return Effect.succeed({} as never);
          },
        }),
      ),
    ),
  );
  const put = (threadId: string, id: string, patch: Partial<FakeRequest> = {}) => {
    const request = { id, kind: "command", status: "pending", responseCapability: live, ...patch };
    requests.set(`${threadId}/${id}`, request);
    return {
      type: "runtime-request.updated",
      threadId,
      payload: request,
    } as unknown as OrchestrationV2DomainEvent;
  };
  return { layer, requests, sends, put };
};

it.effect("a pending live approval becomes one decision, however often it is replayed", () => {
  const { layer, put } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.AssistantApprovalReactor;
    const decisions = yield* DecisionService.DecisionService;
    const event = put(jarvisThread, "req-1");
    yield* reactor.handle(event);
    yield* reactor.handle(event);
    const [decision, ...rest] = yield* decisions.list({});
    assert.lengthOf(rest, 0);
    assert.equal(decision!.approvalRequestId, "req-1");
    assert.equal(decision!.fromThreadId, jarvisThread);
    assert.equal(decision!.threadTitle, "Jarvis");
    assert.equal(decision!.title, "Jarvis wants to run a command");
    assert.include(decision!.context, "rm -rf build");
    assert.include(decision!.context, "Clean the output");
    assert.deepEqual(
      decision!.options.map((option) => [option.id, option.label]),
      [
        ["accept", "Approve"],
        ["decline", "Deny"],
      ],
    );
    assert.isUndefined(decision!.recommended);
  }).pipe(Effect.provide(layer));
});

it.effect("approvals that are not the user's to answer are skipped", () => {
  const { layer, put } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.AssistantApprovalReactor;
    const decisions = yield* DecisionService.DecisionService;
    for (const event of [
      put(jarvisThread, "message", { responseCapability: { type: "message" } }),
      put(jarvisThread, "stuck", { responseCapability: { type: "not_resumable" } }),
      put(jarvisThread, "question", { kind: "user_input" }),
      put("plain-thread", "elsewhere"),
      put(jarvisThread, "done", { status: "resolved" }),
    ]) {
      yield* reactor.handle(event);
    }
    assert.lengthOf(yield* decisions.list({}), 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a request that leaves pending withdraws its decision without a message", () => {
  const { layer, put, sends } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.AssistantApprovalReactor;
    const decisions = yield* DecisionService.DecisionService;
    yield* reactor.handle(put(jarvisThread, "req-1"));
    yield* reactor.handle(put(jarvisThread, "req-1", { status: "resolved" }));
    const [decision] = yield* decisions.list({});
    assert.equal(decision!.status, "withdrawn");
    assert.isDefined(decision!.deliveredAt);
    yield* decisions.deliverPending;
    assert.lengthOf(sends, 0);
    // A late replay of the old pending event does not bring it back.
    yield* reactor.handle(put(jarvisThread, "req-1", { status: "resolved" }));
    assert.lengthOf(yield* decisions.list({}), 1);
  }).pipe(Effect.provide(layer));
});

it.effect("catch-up mirrors what was pending on each current assistant thread", () => {
  const { layer, put } = harness();
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistants (assistant_id, handle, name, project_id, tool_access, thread_id, generation, created_at, updated_at)
      VALUES ('jarvis', 'jarvis', 'Jarvis', 'scratch', 'workspace-write', ${jarvisThread}, 1, 'x', 'x')`;
    put(jarvisThread, "waiting");
    put(jarvisThread, "settled", { status: "resolved" });
    const reactor = yield* Reactor.AssistantApprovalReactor;
    const decisions = yield* DecisionService.DecisionService;
    yield* reactor.catchUp;
    yield* reactor.catchUp;
    assert.deepEqual(
      (yield* decisions.list({})).map((decision) => decision.approvalRequestId),
      ["waiting"],
    );
  }).pipe(Effect.provide(layer));
});
