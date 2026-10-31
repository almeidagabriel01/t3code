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
  const dispatches: Array<Record<string, unknown>> = [];
  /** The runtime requests the thread currently holds. */
  const requests: Array<{ id: string; status: string; responseCapability: unknown }> = [];
  const layer = Decisions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed({ runtimeRequests: requests } as never),
          dispatch: (command) => {
            dispatches.push(command as never);
            return Effect.succeed({} as never);
          },
          sendToThread: (input) => {
            sends.push(input);
            const failure = fail?.(sends.length);
            return failure === undefined ? Effect.succeed({} as never) : Effect.fail(failure);
          },
        }),
      ),
    ),
  );
  return { sends, dispatches, requests, layer };
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
      { title: "t".repeat(121) },
      { context: "c".repeat(4_001) },
      { clientRequestId: "  " },
      { clientRequestId: "x".repeat(513) },
      { options: Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })) },
      { options: [{ id: "a", label: "  " }] },
      { options: [{ id: " ", label: "A" }] },
      { options: [{ id: "a", label: "l".repeat(81) }] },
      { options: [{ id: "a", label: "A", consequence: "c".repeat(201) }] },
      { options: [{ id: "a", label: "A" }], recommended: "b" },
      { expiresInMinutes: -5 },
      { expiresInMinutes: 1.5 },
      { expiresInMinutes: 60 * 24 * 30 + 1 },
    ]) {
      assert.equal((yield* refusal(ask(decisions, bad))).reason, "invalid");
    }
    assert.equal((yield* decisions.list({})).length, 0);
    // The documented limits themselves are accepted.
    yield* ask(decisions, {
      title: "t".repeat(120),
      context: "c".repeat(4_000),
      options: Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, label: "l".repeat(80) })),
      recommended: undefined,
      expiresInMinutes: 60 * 24 * 30,
    });
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

it.effect(
  "a decision settles once: answers and dismissals after it are refused, not delivered twice",
  () => {
    const { layer, sends } = harness();
    return Effect.gen(function* () {
      const decisions = yield* Decisions.DecisionService;
      const missing = "nope" as DecisionId;
      assert.equal((yield* refusal(decisions.get(missing))).reason, "not_found");
      assert.equal(
        (yield* refusal(decisions.answer({ decisionId: missing, optionId: "online" }))).reason,
        "not_found",
      );
      assert.equal((yield* refusal(decisions.dismiss(missing))).reason, "not_found");

      const dismissed = yield* ask(decisions);
      yield* decisions.dismiss(dismissed.id);
      assert.equal(
        (yield* refusal(decisions.answer({ decisionId: dismissed.id, optionId: "online" }))).reason,
        "not_open",
      );

      const answered = yield* ask(decisions, { clientRequestId: "ask-2" });
      // Whitespace alone is no answer.
      assert.equal(
        (yield* refusal(decisions.answer({ decisionId: answered.id, optionId: " ", text: "  " })))
          .reason,
        "invalid",
      );
      yield* decisions.answer({ decisionId: answered.id, optionId: "offline" });
      assert.equal((yield* refusal(decisions.dismiss(answered.id))).reason, "not_open");
      assert.equal((yield* decisions.get(answered.id)).status, "answered");
      assert.equal(sends.length, 2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a decision lapses exactly at its expiry, not a millisecond before", () => {
  const { layer, sends } = harness();
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const early = yield* ask(decisions, { expiresInMinutes: 5 });
    const exact = yield* ask(decisions, { clientRequestId: "ask-2", expiresInMinutes: 5 });
    yield* TestClock.adjust("299999 millis");
    yield* decisions.expireDue;
    assert.equal((yield* decisions.get(early.id)).status, "open");
    assert.equal(
      (yield* decisions.answer({ decisionId: early.id, optionId: "online" })).status,
      "answered",
    );

    yield* TestClock.adjust("1 millis");
    assert.equal(
      (yield* refusal(decisions.answer({ decisionId: exact.id, optionId: "online" }))).reason,
      "not_open",
    );
    yield* decisions.expireDue;
    assert.equal((yield* decisions.get(exact.id)).status, "expired");
    // An answered decision is never expired afterwards.
    assert.equal((yield* decisions.get(early.id)).status, "answered");
    yield* decisions.deliverPending;
    assert.equal(sends.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "delivery to an archived thread is skipped once; other failures give up after 20 tries",
  () => {
    const { layer, sends } = harness((call) =>
      call === 1
        ? ({
            _tag: "ThreadManagementThreadArchivedError",
          } as ThreadManagement.ThreadManagementError)
        : ({
            _tag: "ThreadManagementProjectionLoadError",
          } as ThreadManagement.ThreadManagementError),
    );
    return Effect.gen(function* () {
      const decisions = yield* Decisions.DecisionService;
      const archived = yield* ask(decisions);
      yield* decisions.answer({ decisionId: archived.id, optionId: "online" });
      yield* decisions.deliverPending;
      assert.equal(sends.length, 1);

      const flaky = yield* ask(decisions, { clientRequestId: "ask-2" });
      yield* decisions.answer({ decisionId: flaky.id, optionId: "online" });
      for (let i = 0; i < 25; i += 1) yield* decisions.deliverPending;
      // The answer's own send is try one; the loop adds the rest up to the cap.
      assert.equal(sends.length, 1 + 20);
      assert.equal((yield* decisions.get(flaky.id)).deliveredAt, undefined);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a list keeps every open decision and only the 50 most recent settled ones", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const open = yield* ask(decisions, { clientRequestId: "open" });
    for (let i = 0; i < 52; i += 1) {
      const settled = yield* ask(decisions, { clientRequestId: `s${i}` });
      yield* decisions.dismiss(settled.id);
      yield* TestClock.adjust("1 seconds");
    }
    const listed = yield* decisions.list({});
    assert.equal(listed.length, 51);
    assert.equal(listed[0]!.id, open.id);
    assert.isTrue(listed.slice(1).every((decision) => decision.status === "withdrawn"));
    // Most recent first: the oldest two were cut.
    assert.deepEqual(
      listed.slice(1, 3).map((decision) => decision.createdAt >= listed[3]!.createdAt),
      [true, true],
    );
    assert.equal((yield* decisions.list({ threadId: ThreadId.make("other") })).length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("an approval decision answers its request instead of sending a message", () => {
  const { layer, sends, dispatches, requests } = harness();
  const approval = (clientRequestId: string, supportsFeedback = true) => {
    requests.push({
      id: clientRequestId,
      status: "pending",
      responseCapability: { type: "live", supportsFeedback },
    });
    return {
      clientRequestId,
      approvalRequestId: clientRequestId,
      expiresInMinutes: clientRequestId === "expires" ? 1 : undefined,
      options: [
        { id: "accept", label: "Approve" },
        { id: "decline", label: "Deny" },
      ],
      recommended: undefined,
    };
  };
  return Effect.gen(function* () {
    const decisions = yield* Decisions.DecisionService;
    const decided: Array<[string, unknown, unknown]> = [];
    const settle = (id: string) =>
      Effect.sync(() => {
        const sent = dispatches.filter((command) => command["requestId"] === id);
        decided.push([id, sent[0]?.["decision"], sent[0]?.["feedback"]]);
      });

    const made = yield* ask(decisions, approval("approve"));
    assert.equal(made.approvalRequestId, "approve");
    yield* decisions.answer({ decisionId: made.id, optionId: "accept" });
    yield* settle("approve");
    const denied = yield* ask(decisions, approval("deny"));
    yield* decisions.answer({ decisionId: denied.id, optionId: "decline" });
    yield* settle("deny");
    const text = yield* ask(decisions, approval("text"));
    yield* decisions.answer({ decisionId: text.id, text: "use the dry run" });
    yield* settle("text");
    const noFeedback = yield* ask(decisions, approval("plain", false));
    yield* decisions.answer({ decisionId: noFeedback.id, text: "no" });
    yield* settle("plain");
    const dismissed = yield* ask(decisions, approval("dismiss"));
    yield* decisions.dismiss(dismissed.id);
    yield* settle("dismiss");
    const expiring = yield* ask(decisions, approval("expires"));
    yield* TestClock.adjust("2 minutes");
    yield* decisions.expireDue;
    yield* decisions.deliverPending;
    yield* settle("expires");
    assert.deepEqual(decided, [
      ["approve", "accept", undefined],
      ["deny", "decline", undefined],
      ["text", "decline", "use the dry run"],
      ["plain", "decline", undefined],
      ["dismiss", "decline", undefined],
      ["expires", "decline", undefined],
    ]);
    assert.equal((yield* decisions.get(expiring.id)).status, "expired");
    assert.lengthOf(sends, 0);
    assert.isTrue(
      (yield* decisions.list({})).every((decision) => decision.deliveredAt !== undefined),
    );

    // Answered in the thread meanwhile: delivery is done, nothing is dispatched.
    const late = yield* ask(decisions, approval("late"));
    requests.find((request) => request.id === "late")!.status = "resolved";
    dispatches.length = 0;
    yield* decisions.answer({ decisionId: late.id, optionId: "accept" });
    assert.lengthOf(dispatches, 0);
    assert.isDefined((yield* decisions.get(late.id)).deliveredAt);

    // The reactor taking it back settles it without telling the agent anything.
    const taken = yield* ask(decisions, approval("taken"));
    yield* decisions.withdraw({ decisionId: taken.id, fromThreadId: thread });
    yield* decisions.deliverPending;
    assert.lengthOf(dispatches, 0);
    assert.lengthOf(sends, 0);
  }).pipe(Effect.provide(layer));
});
