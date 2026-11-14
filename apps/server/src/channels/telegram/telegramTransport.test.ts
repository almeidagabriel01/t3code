import { assert, it } from "@effect/vitest";
import type { ChannelGatewayError, ChannelOutboundMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureForkSchema } from "../../persistence/ForkSchema.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { TelegramApiError, type TelegramApi } from "./telegramApi.ts";
import { makeTelegramTransport, type TelegramSendReport } from "./telegramTransport.ts";

const message = (patch: Partial<ChannelOutboundMessage> = {}): ChannelOutboundMessage => ({
  deliveryId: "d1",
  destination: { kind: "telegram", connectionId: "telegram", chatId: "111" },
  text: "hello",
  senderName: "Jarvis",
  ...patch,
});

const harness = (
  script: (text: string, call: number) => TelegramApiError | undefined = () => undefined,
) => {
  const sent: string[] = [];
  const reports: TelegramSendReport[] = [];
  const state = { active: true };
  const api: TelegramApi = {
    getMe: Effect.succeed({ username: "bot" }),
    getUpdates: () => Effect.succeed([]),
    setMyCommands: () => Effect.void,
    downloadFile: () => Effect.die("not used"),
    sendMessage: ({ text }) =>
      Effect.suspend(() => {
        const failure = script(text.html, sent.length + 1);
        if (failure !== undefined) return Effect.fail(failure);
        sent.push(text.html);
        return Effect.succeed({ messageId: String(sent.length) });
      }),
  };
  const transport = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return makeTelegramTransport({
      connectionId: "telegram",
      api: Effect.sync(() => (state.active ? api : undefined)),
      sql,
      hostedAppUrl: "https://app.t3.codes",
      report: (result) => Effect.sync(() => void reports.push(result)),
    });
  });
  return { sent, reports, state, transport };
};

const failure = <A>(exit: Exit.Exit<A, ChannelGatewayError>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
  return Option.isSome(error) ? error.value : undefined;
};

it.effect("sends each piece once, reports success, and answers with the last message id", () => {
  const { sent, reports, transport } = harness();
  return Effect.gen(function* () {
    const receipt = yield* (yield* transport).send(message({ text: "a".repeat(5000) }));
    assert.lengthOf(sent, 2);
    assert.strictEqual(receipt.externalMessageId, "2");
    assert.deepStrictEqual(reports, [{ ok: true }]);
    // A repeat of the same delivery sends nothing new.
    const again = yield* (yield* transport).send(message({ text: "a".repeat(5000) }));
    assert.lengthOf(sent, 2);
    assert.isUndefined(again.externalMessageId);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));
});

it.effect(
  "a retry sends again every piece Telegram did not confirm, and never a confirmed one",
  () => {
    const refuse = new TelegramApiError({
      code: "chat_not_found",
      outcome: "not_sent",
      retryAfterSeconds: 2.2,
    });
    const lost = new TelegramApiError({ code: "timeout", outcome: "unknown" });
    const bad = new TelegramApiError({ code: "invalid_token", outcome: "not_sent" });
    let next: TelegramApiError | undefined = refuse;
    const { sent, reports, transport } = harness(() => next);
    return Effect.gen(function* () {
      const t = yield* transport;
      const text = "a".repeat(5000);
      const first = failure(yield* Effect.exit(t.send(message({ text }))));
      assert.deepStrictEqual(
        [first?.reason, first?.deliveryOutcome, first?.deliveryErrorCode, first?.retryAfterSeconds],
        ["delivery_failed", "not_sent", "chat_not_found", 3],
      );
      assert.deepStrictEqual(reports.at(-1), {
        ok: false,
        code: "chat_not_found",
        invalidToken: false,
      });
      next = undefined;
      yield* t.send(message({ text }));
      assert.lengthOf(sent, 2);

      next = lost;
      const unknown = failure(
        yield* Effect.exit(t.send(message({ deliveryId: "d2", text: "hi" }))),
      );
      assert.deepStrictEqual(
        [unknown?.deliveryOutcome, unknown?.deliveryErrorCode],
        ["unknown", "timeout"],
      );
      // Telegram never confirmed it, so it goes again rather than being lost.
      next = undefined;
      yield* t.send(message({ deliveryId: "d2", text: "hi" }));
      assert.lengthOf(sent, 3);
      yield* t.send(message({ deliveryId: "d2", text: "hi" }));
      assert.lengthOf(sent, 3);

      next = bad;
      yield* Effect.exit(t.send(message({ deliveryId: "d3", text: "hi" })));
      assert.deepStrictEqual(reports.at(-1), { ok: false, code: "unknown", invalidToken: true });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory));
  },
);

it.effect("a dropped later piece is sent again without repeating the confirmed first one", () => {
  const dropped = new TelegramApiError({ code: "unreachable", outcome: "unknown" });
  let calls = 0;
  const { sent, transport } = harness(() => (++calls === 2 ? dropped : undefined));
  return Effect.gen(function* () {
    const t = yield* transport;
    const text = "a".repeat(5000);
    const exit = yield* Effect.exit(t.send(message({ text })));
    assert.strictEqual(failure(exit)?.deliveryOutcome, "unknown");
    assert.lengthOf(sent, 1);
    yield* t.send(message({ text }));
    assert.strictEqual(calls, 3);
    assert.lengthOf(sent, 2);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));
});

it.effect("an upgrade leaves unconfirmed only the last piece of a delivery left ambiguous", () => {
  const { sent, transport } = harness();
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // What an older build left: both pieces claimed, the second one's send timed out.
    yield* sql`ALTER TABLE telegram_sent DROP COLUMN confirmed`;
    yield* sql`INSERT INTO telegram_sent (delivery_id, chunk_index, sent_at_ms) VALUES ('d1', 0, 1), ('d1', 1, 1)`;
    yield* sql`
      INSERT INTO channel_outbox (delivery_id, message_json, state, next_attempt_at, created_at)
      VALUES ('d1', '{}', 'ambiguous', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
    yield* ensureForkSchema();
    yield* (yield* transport).send(message({ text: "a".repeat(5000) }));
    // Only the second piece goes again.
    assert.lengthOf(sent, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));
});

it.effect("refuses another connection and a channel that is off, sending nothing", () => {
  const { sent, state, transport } = harness();
  return Effect.gen(function* () {
    const t = yield* transport;
    const elsewhere = failure(
      yield* Effect.exit(
        t.send(message({ destination: { kind: "telegram", connectionId: "other", chatId: "1" } })),
      ),
    );
    assert.strictEqual(elsewhere?.reason, "invalid_input");
    const imessage = failure(
      yield* Effect.exit(
        t.send(
          message({ destination: { kind: "imessage", connectionId: "telegram", chatGuid: "g" } }),
        ),
      ),
    );
    assert.strictEqual(imessage?.reason, "invalid_input");
    state.active = false;
    const off = failure(yield* Effect.exit(t.send(message())));
    assert.deepStrictEqual(
      [off?.reason, off?.deliveryOutcome],
      ["adapter_unavailable", "not_sent"],
    );
    assert.lengthOf(sent, 0);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));
});
