import { assert, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as DecisionService from "../decisions/DecisionService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as NeedsUser from "./NeedsUser.ts";

const thread = ThreadId.make("thread-1");

const requestEvent = (id: string, kind: string, status: string) =>
  ({
    type: "runtime-request.updated",
    threadId: thread,
    payload: {
      id,
      kind,
      status,
      createdAt: DateTime.makeUnsafe(0),
      responseCapability: { type: "live", providerSessionId: "s1" },
    },
  }) as never as OrchestrationV2DomainEvent;

const decision = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    fromThreadId: thread,
    threadTitle: "Fix",
    title: `Decide ${id}`,
    context: "Which one?",
    options: [{ id: "a", label: "A" }],
    status,
    createdAt: "2026-01-02T00:00:00.000Z",
    ...extra,
  }) as never;

const layer = (open: { readonly decision: boolean; readonly request: boolean }) =>
  NeedsUser.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        Layer.mock(Orchestrator.OrchestratorV2)({
          subscribeDomainEvents: Effect.succeed(
            Stream.fromIterable([
              requestEvent("r1", "command", "pending"),
              requestEvent("r2", "dynamic_tool_call", "pending"),
              requestEvent("r1", "command", "resolved"),
            ]),
          ),
        }),
        Layer.mock(DecisionService.DecisionService)({
          subscribe: Stream.fromIterable([
            { type: "snapshot", decisions: [decision("d0", "open")] },
            { type: "upserted", decision: decision("d1", "open") },
            { type: "upserted", decision: decision("d2", "open", { notice: true }) },
            { type: "upserted", decision: decision("d3", "open", { approvalRequestId: "r1" }) },
            { type: "upserted", decision: decision("d1", "answered") },
          ] as never),
          list: () =>
            Effect.succeed([
              decision("d1", "open"),
              decision("d2", "open", { notice: true }),
              decision("d4", "answered"),
            ]),
          get: (id) => Effect.succeed(decision(id, open.decision ? "open" : "answered")),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeResponseContext: () =>
            Effect.succeed({
              request: {
                kind: "command",
                status: open.request ? "pending" : "resolved",
                responseCapability: { type: "live", providerSessionId: "s1" },
              },
              item: { type: "approval_request", prompt: "pnpm publish" },
            } as never),
        }),
      ),
    ),
  );

it.effect("changes open with what waits, then carry only what waits on the user", () =>
  Effect.gen(function* () {
    const changes = yield* Stream.runCollect((yield* NeedsUser.NeedsUser).changes);
    // The two sources interleave; each keeps its own order.
    const keys = changes.map((change) => `${change.type} ${change.wait.key}`);
    assert.deepStrictEqual(
      keys.filter((key) => key.includes("request:")),
      ["opened request:r1", "resolved request:r1"],
    );
    assert.deepStrictEqual(
      keys.filter((key) => key.includes("decision:")),
      // d0 was open when the subscription began: its snapshot comes first.
      ["opened decision:d0", "opened decision:d1", "resolved decision:d1"],
    );
  }).pipe(Effect.provide(layer({ decision: true, request: true }))),
);

it.effect("pending lists user requests and open decisions; describe follows the live state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('r1', ${thread}, 'n1', 'command', 'pending', '2026-01-01T00:00:00.000Z', '{}'),
        ('r2', ${thread}, 'n1', 'auth_refresh', 'pending', '2026-01-01T00:00:00.000Z', '{}'),
        ('r3', ${thread}, 'n1', 'command', 'resolved', '2026-01-01T00:00:00.000Z', '{}')`;
    const needsUser = yield* NeedsUser.NeedsUser;
    const pending = yield* needsUser.pending;
    assert.deepStrictEqual(
      pending.map((wait) => wait.key),
      ["request:r1", "decision:d1"],
    );
    const [request, open] = pending;
    const asked = yield* needsUser.describe(request!, "Claude");
    assert.strictEqual(Option.getOrThrow(asked).title, "Claude wants to run a command");
    assert.include(Option.getOrThrow(asked).context, "pnpm publish");
    assert.strictEqual(
      Option.getOrThrow(yield* needsUser.describe(open!, "Claude")).title,
      "Decide d1",
    );
  }).pipe(Effect.provide(layer({ decision: true, request: true }))),
);

it.effect("describe is None once the request or decision is settled", () =>
  Effect.gen(function* () {
    const needsUser = yield* NeedsUser.NeedsUser;
    const changes = yield* Stream.runCollect(needsUser.changes);
    for (const change of changes) {
      assert.isTrue(Option.isNone(yield* needsUser.describe(change.wait, "Claude")));
    }
  }).pipe(Effect.provide(layer({ decision: false, request: false }))),
);

it.effect("a source that fails resubscribes, and replays what opened while it was down", () => {
  const attempts = { domain: 0, decisions: 0 };
  const insertPending = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runtime_requests
          (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES (${id}, ${thread}, 'n1', 'command', 'pending', '2026-01-01T00:00:00.000Z', '{}')`;
    });
  // r8 opens while the source is down. r9 opens right after the resubscription anchors and
  // before the re-read, so it comes through the stream and the read alike.
  const subscribeDomainEvents = Effect.gen(function* () {
    attempts.domain += 1;
    if (attempts.domain === 1) {
      yield* insertPending("r8");
      return yield* Effect.fail(new Error("dropped") as never);
    }
    yield* insertPending("r9");
    return Stream.fromIterable([requestEvent("r9", "command", "pending")]);
  });
  const decisionSubscribe = Stream.unwrap(
    Effect.sync(() => {
      attempts.decisions += 1;
      return attempts.decisions === 1
        ? Stream.fail(new Error("dropped"))
        : Stream.fromIterable([
            { type: "snapshot", decisions: [decision("d5", "open")] },
            { type: "upserted", decision: decision("d1", "open") },
          ]);
    }),
  );
  const flaky = NeedsUser.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        Layer.mock(Orchestrator.OrchestratorV2)({
          subscribeDomainEvents: subscribeDomainEvents as never,
        }),
        Layer.mock(DecisionService.DecisionService)({ subscribe: decisionSubscribe as never }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      ),
    ),
  );
  return Effect.gen(function* () {
    const collecting = yield* Stream.runCollect((yield* NeedsUser.NeedsUser).changes).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    const keys = (yield* Fiber.join(collecting)).map(
      (change) => `${change.type} ${change.wait.key}`,
    );
    assert.deepStrictEqual(attempts, { domain: 2, decisions: 2 });
    assert.deepStrictEqual([...new Set(keys)].toSorted(), [
      "opened decision:d1",
      "opened decision:d5",
      "opened request:r8",
      "opened request:r9",
    ]);
    // The re-read follows the anchored subscription, so r9 arrives twice and r8 once.
    assert.strictEqual(keys.filter((key) => key === "opened request:r9").length, 2);
    assert.strictEqual(keys.filter((key) => key === "opened request:r8").length, 1);
  }).pipe(Effect.provide(flaky));
});
