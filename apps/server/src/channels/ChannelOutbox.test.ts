import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
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
  { name: "unknown outcome", error: { deliveryOutcome: "unknown" as const }, state: "ambiguous" },
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
