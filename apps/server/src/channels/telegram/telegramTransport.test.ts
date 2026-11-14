import { assert, it } from "@effect/vitest";
import type { ChannelGatewayError, ChannelOutboundMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

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
  "releases a piece Telegram refused, and keeps the claim when the outcome is unknown",
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
      // Released, so the retry sends both pieces.
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
      // Claimed: a retry does not risk a duplicate.
      next = undefined;
      yield* t.send(message({ deliveryId: "d2", text: "hi" }));
      assert.lengthOf(sent, 2);

      next = bad;
      yield* Effect.exit(t.send(message({ deliveryId: "d3", text: "hi" })));
      assert.deepStrictEqual(reports.at(-1), { ok: false, code: "unknown", invalidToken: true });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory));
  },
);

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
