import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { deliveryError, dmAddress, fakeTransport, outboxRows } from "./channelBridgeTestSupport.ts";
import * as ChannelOutbox from "./ChannelOutbox.ts";
import * as ChannelTransport from "./ChannelTransport.ts";

const layer = ChannelOutbox.layer.pipe(
  Layer.provideMerge(ChannelTransport.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const message = (deliveryId: string, text = deliveryId) => ({
  deliveryId,
  destination: dmAddress,
  text,
  senderName: "Jarvis",
});

it.effect("enqueue is idempotent and rows are delivered in creation order", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const { sent, transport } = fakeTransport();
    yield* registry.register(transport);
    yield* outbox.enqueue(message("a"));
    yield* outbox.enqueue(message("a", "changed"));
    yield* outbox.enqueue(message("b"));
    yield* outbox.drain;
    yield* outbox.drain;
    assert.deepEqual(
      sent.map((m) => m.text),
      ["a", "b"],
    );
    const rows = yield* outboxRows;
    assert.deepEqual(
      rows.map((row) => [row.delivery_id, row.state, row.external_message_id]),
      [
        ["a", "sent", "ts-1"],
        ["b", "sent", "ts-2"],
      ],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("redacts every message once, before it is stored or reaches a transport", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const { sent, transport } = fakeTransport();
    yield* registry.register(transport);
    const token = "ghp_" + "Z".repeat(32);
    yield* outbox.enqueue({
      ...message("s", `deploy with ${token} and password=hunter2`),
      choices: [{ label: `use ${token}`, value: "a" }],
    });
    yield* outbox.drain;
    assert.deepEqual(sent[0]?.text, "deploy with [redacted] and password=[redacted]");
    assert.deepEqual(sent[0]?.choices, [{ label: "use [redacted]", value: "a" }]);
    const rows = yield* outboxRows;
    assert.notInclude(JSON.stringify(rows), token);
    assert.notInclude(JSON.stringify(rows), "hunter2");
  }).pipe(Effect.provide(layer)),
);

const failures = [
  { name: "unknown outcome", error: { deliveryOutcome: "unknown" as const }, state: "pending" },
  ...(["automation_denied", "messages_not_signed_in", "chat_not_found"] as const).map((code) => ({
    name: code,
    error: { deliveryErrorCode: code },
    state: "failed",
  })),
  { name: "unknown code", error: { deliveryErrorCode: "unknown" as const }, state: "pending" },
  { name: "no code", error: { deliveryErrorCode: undefined as never }, state: "pending" },
];

it.effect.each(failures)("a $name failure ends in $state", (failure) =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const { sent, transport } = fakeTransport(() => Effect.fail(deliveryError(failure.error)));
    yield* registry.register(transport);
    yield* outbox.enqueue(message("a"));
    yield* outbox.drain;
    const [row] = yield* outboxRows;
    assert.equal(row!.state, failure.state);
    assert.isNotNull(row!.last_error_code);
    if (failure.state !== "pending") {
      yield* TestClock.adjust("1 hour");
      yield* outbox.drain;
      assert.lengthOf(sent, 1);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("a retryable failure backs off exponentially and honors retryAfterSeconds", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const { sent, transport } = fakeTransport((_message, call) =>
      call === 1
        ? Effect.fail(deliveryError())
        : call === 2
          ? Effect.fail(deliveryError({ retryAfterSeconds: 120 }))
          : Effect.succeed("ts"),
    );
    yield* registry.register(transport);
    yield* outbox.enqueue(message("a"));
    yield* outbox.drain;
    assert.lengthOf(sent, 1);
    yield* TestClock.adjust("1 second");
    yield* outbox.drain;
    assert.lengthOf(sent, 1);
    yield* TestClock.adjust("1 second");
    yield* outbox.drain;
    assert.lengthOf(sent, 2);
    yield* TestClock.adjust("119 seconds");
    yield* outbox.drain;
    assert.lengthOf(sent, 2);
    yield* TestClock.adjust("1 second");
    yield* outbox.drain;
    assert.lengthOf(sent, 3);
    const [row] = yield* outboxRows;
    assert.deepEqual([row!.state, row!.attempts], ["sent", 2]);
  }).pipe(Effect.provide(layer)),
);

it.effect("it gives up after ten attempts, with delays capped at five minutes", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const { sent, transport } = fakeTransport(() => Effect.fail(deliveryError()));
    yield* registry.register(transport);
    yield* outbox.enqueue(message("a"));
    for (let attempt = 0; attempt < 10; attempt++) {
      yield* outbox.drain;
      yield* TestClock.adjust("300 seconds");
    }
    yield* outbox.drain;
    assert.lengthOf(sent, 10);
    const [row] = yield* outboxRows;
    assert.deepEqual([row!.state, row!.attempts, row!.last_error_code], ["failed", 10, "unknown"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("a send that may have posted is retried, and after ten tries is left ambiguous", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const { sent, transport } = fakeTransport(() =>
      Effect.fail(deliveryError({ deliveryOutcome: "unknown", deliveryErrorCode: "timeout" })),
    );
    yield* registry.register(transport);
    yield* outbox.enqueue(message("a"));
    for (let attempt = 0; attempt < 12; attempt++) {
      yield* outbox.drain;
      yield* TestClock.adjust("300 seconds");
    }
    assert.lengthOf(sent, 10);
    const [row] = yield* outboxRows;
    assert.deepEqual(
      [row!.state, row!.attempts, row!.last_error_code],
      ["ambiguous", 10, "timeout"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("a network failure followed by success delivers the message once", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const { sent, transport } = fakeTransport((_message, call) =>
      call === 1
        ? Effect.fail(deliveryError({ deliveryOutcome: "unknown", deliveryErrorCode: "unknown" }))
        : Effect.succeed("ts"),
    );
    yield* registry.register(transport);
    yield* outbox.enqueue(message("a"));
    yield* outbox.drain;
    yield* TestClock.adjust("2 seconds");
    yield* outbox.drain;
    yield* TestClock.adjust("1 hour");
    yield* outbox.drain;
    assert.lengthOf(sent, 2);
    const [row] = yield* outboxRows;
    assert.deepEqual([row!.state, row!.attempts], ["sent", 1]);
  }).pipe(Effect.provide(layer)),
);

/** Fails every send of `a` until `down` is false; every other delivery goes through. */
const outage = () => {
  const state = { down: true };
  const { sent, transport } = fakeTransport((m) =>
    m.deliveryId === "a" && state.down
      ? Effect.fail(deliveryError({ deliveryOutcome: "unknown", deliveryErrorCode: "unknown" }))
      : Effect.succeed("ts"),
  );
  return { state, sent, transport };
};

const exhaust = Effect.gen(function* () {
  const outbox = yield* ChannelOutbox.ChannelOutbox;
  for (let attempt = 0; attempt < 12; attempt++) {
    yield* outbox.drain;
    yield* TestClock.adjust("300 seconds");
  }
});

it.effect("once a send to the channel works again, what ran out of tries goes once more", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const { state, sent, transport } = outage();
    yield* registry.register(transport);
    const counts: number[] = [];
    yield* outbox.undeliveredCount("imessage").pipe(
      Stream.runForEach((n) => Effect.sync(() => void counts.push(n))),
      Effect.forkScoped,
    );
    yield* outbox.enqueue(message("a"));
    yield* exhaust;
    assert.equal((yield* outboxRows)[0]!.state, "ambiguous");
    // Another chat is still down, so the next success elsewhere on this connection brings it back.
    yield* outbox.enqueue({ ...message("b"), destination: { ...dmAddress, connectionId: "c2" } });
    yield* outbox.drain;
    assert.equal((yield* outboxRows)[0]!.state, "ambiguous");
    state.down = false;
    yield* outbox.enqueue(message("c"));
    yield* outbox.drain;
    yield* outbox.drain;
    const rows = yield* outboxRows;
    assert.deepEqual(
      rows.map((row) => [row.delivery_id, row.state]),
      [
        ["a", "sent"],
        ["b", "sent"],
        ["c", "sent"],
      ],
    );
    assert.equal(sent.filter((m) => m.deliveryId === "a").length, 11);
    yield* Effect.yieldNow;
    assert.deepEqual(counts.at(-1), 0);
    assert.include(counts, 1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a requeued message that fails again is not requeued a second time", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const { sent, transport } = outage();
    yield* registry.register(transport);
    yield* outbox.enqueue(message("a"));
    yield* exhaust;
    yield* outbox.enqueue(message("b"));
    yield* exhaust;
    assert.equal(sent.filter((m) => m.deliveryId === "a").length, 20);
    yield* outbox.enqueue(message("c"));
    yield* exhaust;
    assert.equal(sent.filter((m) => m.deliveryId === "a").length, 20);
    assert.equal((yield* outboxRows)[0]!.state, "ambiguous");
  }).pipe(Effect.provide(layer)),
);

it.effect("resend puts every undelivered message of a channel back in line", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    let refuse = true;
    const { sent, transport } = fakeTransport(() =>
      refuse
        ? Effect.fail(deliveryError({ deliveryErrorCode: "chat_not_found" }))
        : Effect.succeed("ts"),
    );
    yield* registry.register(transport);
    yield* outbox.enqueue(message("a"));
    yield* outbox.drain;
    assert.equal((yield* outboxRows)[0]!.state, "failed");
    assert.equal(yield* outbox.resend("telegram"), 0);
    refuse = false;
    assert.equal(yield* outbox.resend("imessage"), 1);
    assert.equal(yield* outbox.resend("imessage"), 0);
    yield* outbox.drain;
    assert.lengthOf(sent, 2);
    assert.deepEqual(
      (yield* outboxRows).map((row) => [row.state, row.attempts]),
      [["sent", 0]],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("without a transport the row stays pending and goes out once one registers", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    yield* outbox.enqueue(message("a"));
    yield* outbox.drain;
    const [waiting] = yield* outboxRows;
    assert.deepEqual([waiting!.state, waiting!.attempts], ["pending", 0]);
    const { sent, transport } = fakeTransport();
    yield* registry.register(transport);
    yield* outbox.drain;
    assert.lengthOf(sent, 0);
    yield* TestClock.adjust("30 seconds");
    yield* outbox.drain;
    assert.lengthOf(sent, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("the worker sends what is enqueued without being asked", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const delivered = yield* Deferred.make<void>();
    const { sent, transport } = fakeTransport(() =>
      Deferred.succeed(delivered, undefined).pipe(Effect.as("ts")),
    );
    yield* registry.register(transport);
    yield* outbox.start();
    yield* outbox.enqueue({ ...message("a"), choices: [{ label: "Yes", value: "v" }] });
    yield* Deferred.await(delivered);
    assert.deepEqual(sent[0]!.choices, [{ label: "Yes", value: "v" }]);
  }).pipe(Effect.provide(layer)),
);

it.effect("one undecodable row never holds back the rest", () =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const sql = yield* SqlClient.SqlClient;
    const { sent, transport } = fakeTransport();
    yield* registry.register(transport);
    yield* sql`
      INSERT INTO channel_outbox (delivery_id, message_json, state, next_attempt_at, created_at)
      VALUES ('bad', '{', 'pending', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
    yield* outbox.enqueue(message("a"));
    yield* outbox.drain;
    assert.deepEqual(
      sent.map((m) => m.deliveryId),
      ["a"],
    );
  }).pipe(Effect.provide(layer)),
);
