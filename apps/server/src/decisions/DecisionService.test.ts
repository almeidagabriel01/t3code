import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  DecisionError,
  ProjectId,
  ThreadId,
  type DecisionsEvent,
  type DecisionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Decisions from "./DecisionService.ts";

const thread = ThreadId.make("thread-1");
const project = ProjectId.make("project-1");
const isDecisionError = Schema.is(DecisionError);

type Send = Parameters<ThreadManagement.ThreadManagementService["Service"]["sendToThread"]>[0];

/** `fail` decides per call; the default accepts every send. */
const harness = (fail?: (call: number) => ThreadManagement.ThreadManagementError | undefined) => {
  const sends: Send[] = [];
  const layer = Decisions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) => {
            sends.push(input);
            const failure = fail?.(sends.length);
            return failure === undefined ? Effect.succeed({} as never) : Effect.fail(failure);
          },
        }),
      ),
    ),
  );
  return { sends, layer };
};

const ask = (
  decisions: Decisions.DecisionService["Service"],
  overrides: Partial<Parameters<typeof decisions.request>[0]> = {},
) =>
  decisions.request({
    fromThreadId: thread,
    projectId: project,
    threadTitle: "Migrate the schema",
    clientRequestId: "ask-1",
    title: "Pick a migration strategy",
    context: "Two ways to do it.",
    options: [
      { id: "online", label: "Online", consequence: "Slower, no downtime" },
      { id: "offline", label: "Offline" },
    ],
    recommended: "online",
    ...overrides,
  });

const refusal = <A>(effect: Effect.Effect<A, DecisionError>) =>
  effect.pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => assert.isTrue(isDecisionError(error)))),
  );

it.effect("a repeated request returns the first decision, a new request id a new one", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const first = yield* ask(decisions);
    const again = yield* ask(decisions, { title: "Changed wording" });
    assert.equal(again.id, first.id);
    assert.equal(again.title, "Pick a migration strategy");
    const other = yield* ask(decisions, { clientRequestId: "ask-2" });
    assert.notEqual(other.id, first.id);
    assert.deepEqual(
      (yield* decisions.list({ threadId: thread })).map((decision) => decision.id),
      [first.id, other.id],
    );
    assert.equal((yield* decisions.list({ threadId: ThreadId.make("other") })).length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a request that cannot be answered is refused", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    for (const bad of [
      { options: [] },
      {
        options: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      },
      { recommended: "missing" },
      { title: "   " },
      { expiresInMinutes: 0 },
    ]) {
      assert.equal((yield* refusal(ask(decisions, bad))).reason, "invalid");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("an answer reaches the thread as one queued message, however often delivery runs", () => {
  // The first send fails after the answer is stored, as a crash before the receipt would.
  const { layer, sends } = harness((call) =>
    call === 1
      ? ({ _tag: "ThreadManagementProjectionLoadError" } as ThreadManagement.ThreadManagementError)
      : undefined,
  );
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const decision = yield* ask(decisions);

    assert.equal(
      (yield* refusal(decisions.answer({ decisionId: decision.id, optionId: "nope" }))).reason,
      "invalid",
    );
    assert.equal((yield* refusal(decisions.answer({ decisionId: decision.id }))).reason, "invalid");

    const answered = yield* decisions.answer({
      decisionId: decision.id,
      optionId: "online",
      text: "after the release",
    });
    assert.equal(answered.status, "answered");
    assert.equal(answered.deliveredAt, undefined);
    assert.equal(sends.length, 1);

    yield* decisions.deliverPending;
    yield* decisions.deliverPending;
    yield* decisions.deliverPending;
    assert.equal(sends.length, 2);
    for (const send of sends) {
      assert.equal(send.commandId, `decision-answer:${decision.id}`);
      assert.equal(send.messageId, `decision-answer:${decision.id}`);
      assert.equal(send.threadId, thread);
      assert.equal(send.projectId, project);
      assert.equal(send.mode, "queue");
    }
    assert.include(sends[1]!.text, "Chosen: Online (Slower, no downtime)");
    assert.include(sends[1]!.text, "Answer: after the release");
    assert.isDefined((yield* decisions.get(decision.id)).deliveredAt);

    assert.equal(
      (yield* refusal(decisions.answer({ decisionId: decision.id, optionId: "offline" }))).reason,
      "not_open",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("free text alone answers a decision", () => {
  const { layer, sends } = harness();
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const decision = yield* ask(decisions);
    yield* decisions.answer({ decisionId: decision.id, text: "Neither, use a shadow table" });
    assert.include(sends[0]!.text, "Answer: Neither, use a shadow table");
    assert.notInclude(sends[0]!.text, "Chosen:");
  }).pipe(Effect.provide(layer));
});

it.effect("dismissing tells the agent nothing was approved, and cannot be repeated", () => {
  const { layer, sends } = harness();
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const decision = yield* ask(decisions);
    const dismissed = yield* decisions.dismiss(decision.id);
    assert.equal(dismissed.status, "withdrawn");
    assert.equal(sends.length, 1);
    assert.include(sends[0]!.text, "dismissed");
    assert.include(sends[0]!.text, "do not assume approval");
    assert.notInclude(sends[0]!.text, "Chosen");
    assert.equal((yield* refusal(decisions.dismiss(decision.id))).reason, "not_open");
  }).pipe(Effect.provide(layer));
});

it.effect("an unanswered decision expires and the agent is told not to assume approval", () => {
  const { layer, sends } = harness();
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const decision = yield* ask(decisions, { expiresInMinutes: 5 });
    const kept = yield* ask(decisions, { clientRequestId: "ask-2" });

    yield* TestClock.adjust("4 minutes");
    yield* decisions.expireDue;
    assert.equal((yield* decisions.get(decision.id)).status, "open");

    yield* TestClock.adjust("2 minutes");
    assert.equal(
      (yield* refusal(decisions.answer({ decisionId: decision.id, optionId: "online" }))).reason,
      "not_open",
    );
    yield* decisions.expireDue;
    yield* decisions.deliverPending;
    yield* decisions.deliverPending;

    assert.equal((yield* decisions.get(decision.id)).status, "expired");
    assert.equal((yield* decisions.get(kept.id)).status, "open");
    assert.equal(sends.length, 1);
    assert.include(sends[0]!.text, "expired");
    assert.include(sends[0]!.text, "do not assume approval");
  }).pipe(Effect.provide(layer));
});

it.effect("a thread that is gone is skipped once and never retried", () => {
  const { layer, sends } = harness(
    () =>
      ({
        _tag: "ThreadManagementThreadNotFoundError",
      }) as ThreadManagement.ThreadManagementError,
  );
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const decision = yield* ask(decisions);
    yield* decisions.answer({ decisionId: decision.id, optionId: "online" });
    yield* decisions.deliverPending;
    yield* decisions.deliverPending;
    assert.equal(sends.length, 1);
    assert.equal((yield* decisions.get(decision.id)).deliveredAt, undefined);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "an agent withdraws its own decision; repeating or answering later changes nothing",
  () => {
    const { layer, sends } = harness();
    return Effect.gen(function* () {
      const decisions = yield* Decisions.DecisionService;
      const decision = yield* ask(decisions);
      assert.equal(
        (yield* refusal(
          decisions.withdraw({ decisionId: decision.id, fromThreadId: ThreadId.make("x") }),
        )).reason,
        "not_found",
      );
      const withdrawn = yield* decisions.withdraw({
        decisionId: decision.id,
        fromThreadId: thread,
      });
      assert.equal(withdrawn.status, "withdrawn");
      const again = yield* decisions.withdraw({ decisionId: decision.id, fromThreadId: thread });
      assert.equal(again.status, "withdrawn");
      assert.equal(
        (yield* refusal(decisions.answer({ decisionId: decision.id, optionId: "online" }))).reason,
        "not_open",
      );
      yield* decisions.deliverPending;
      assert.equal(sends.length, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("subscribe sends a snapshot, then each change", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const received = yield* Queue.unbounded<DecisionsEvent>();
    yield* decisions.subscribe.pipe(
      Stream.take(3),
      Stream.runForEach((event) => Queue.offer(received, event)),
      Effect.forkChild,
    );
    assert.deepEqual(yield* Queue.take(received), { type: "snapshot", decisions: [] });
    const decision = yield* ask(decisions);
    yield* decisions.answer({ decisionId: decision.id, optionId: "offline" });
    const events = [yield* Queue.take(received), yield* Queue.take(received)];
    assert.deepEqual(
      events.map((event) => event.type === "upserted" && event.decision.status),
      ["open", "answered"],
    );
    const id: DecisionId = decision.id;
    assert.isTrue(events.every((event) => event.type === "upserted" && event.decision.id === id));
  }).pipe(Effect.provide(layer));
});
