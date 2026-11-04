import { assert, it } from "@effect/vitest";

import type { TelegramMessage, TelegramUpdate } from "./telegramApi.ts";
import { admitTelegramUpdate } from "./telegramAdmission.ts";

const ALLOWED = new Set(["111"]);

const update = (patch: Partial<TelegramMessage> | undefined, updateId = 9): TelegramUpdate => ({
  updateId,
  message:
    patch === undefined
      ? undefined
      : {
          message_id: 4,
          date: 1_800_000_000,
          text: "hello",
          chat: { id: 111, type: "private" },
          from: { id: 111, first_name: " Ana " },
          ...patch,
        },
});

const skipReason = (input: TelegramUpdate) => {
  const admission = admitTelegramUpdate(input, ALLOWED, "telegram");
  return admission.type === "skip" ? admission.reason : "message";
};

it("hears only allowed people writing to the bot in a private chat", () => {
  assert.strictEqual(skipReason(update(undefined)), "kind");
  assert.strictEqual(skipReason(update({ chat: { id: -5, type: "supergroup" } })), "chat");
  assert.strictEqual(skipReason(update({ from: undefined })), "sender");
  assert.strictEqual(skipReason(update({ from: { id: 222 } })), "sender");
  assert.strictEqual(skipReason(update({ from: { id: 111, is_bot: true } })), "sender");
  assert.strictEqual(skipReason(update({ text: undefined })), "text");
  assert.strictEqual(skipReason(update({ text: "   " })), "text");
  assert.strictEqual(skipReason(update({})), "message");
});

it("hands the gateway a message keyed by chat and update, so a redelivery is one message", () => {
  const admission = admitTelegramUpdate(
    update({ text: "  @Jarvis hi  " }, 42),
    ALLOWED,
    "telegram",
  );
  assert.deepStrictEqual(admission.type === "message" && admission.inbound, {
    kind: "telegram",
    connectionId: "telegram",
    conversationKey: "111",
    externalMessageId: "4",
    idempotencyKey: "telegram:42",
    actor: { externalActorId: "111", displayName: "Ana" },
    replyAddress: { kind: "telegram", connectionId: "telegram", chatId: "111" },
    text: "@Jarvis hi",
    receivedAt: "2027-01-15T08:00:00.000Z",
  });
});

it("reads /start as a request for the roster, and clamps an impossible date", () => {
  for (const text of ["/start", "/start@my_bot", "/START now"]) {
    const admission = admitTelegramUpdate(update({ text }), ALLOWED, "telegram");
    assert.strictEqual(admission.type === "message" && admission.inbound.text, "@");
  }
  const kept = admitTelegramUpdate(update({ text: "/starting" }), ALLOWED, "telegram");
  assert.strictEqual(kept.type === "message" && kept.inbound.text, "/starting");
  const far = admitTelegramUpdate(
    update({ date: Number.MAX_SAFE_INTEGER, from: { id: 111 } }),
    ALLOWED,
    "telegram",
  );
  assert.strictEqual(far.type === "message" && far.inbound.receivedAt, "2100-01-01T00:00:00.000Z");
  assert.isUndefined(far.type === "message" ? far.inbound.actor.displayName : "x");
});
