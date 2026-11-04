import type { ChannelInboundMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { TelegramUpdate } from "./telegramApi.ts";

/** The latest date worth representing, in seconds; a message dated beyond it is clamped. */
const MAX_DATE_SECONDS = 4_102_444_800;

export type TelegramAdmission =
  | { readonly type: "skip"; readonly reason: "kind" | "chat" | "sender" | "text" }
  | { readonly type: "message"; readonly inbound: ChannelInboundMessage };

/**
 * Decides whether an update is something an allowed person said to the bot in a private chat.
 * Everything else, including groups, bots, unknown senders and attachments, is ignored.
 * `/start`, the first thing Telegram sends, lists the assistants like a bare `@`.
 */
export function admitTelegramUpdate(
  update: TelegramUpdate,
  allowedUserIds: ReadonlySet<string>,
  connectionId: string,
): TelegramAdmission {
  const { message } = update;
  if (message === undefined) return { type: "skip", reason: "kind" };
  if (message.chat.type !== "private") return { type: "skip", reason: "chat" };
  const from = message.from;
  if (from === undefined || from.is_bot === true || !allowedUserIds.has(String(from.id))) {
    return { type: "skip", reason: "sender" };
  }
  const raw = message.text?.trim();
  if (!raw) return { type: "skip", reason: "text" };
  const text = /^\/start(?:@\w+)?(?:\s|$)/i.test(raw) ? "@" : raw;
  const chatId = String(message.chat.id);
  return {
    type: "message",
    inbound: {
      kind: "telegram",
      connectionId,
      conversationKey: chatId,
      externalMessageId: String(message.message_id),
      idempotencyKey: `${connectionId}:${update.updateId}`,
      actor: {
        externalActorId: String(from.id),
        ...(from.first_name?.trim() ? { displayName: from.first_name.trim() } : {}),
      },
      replyAddress: { kind: "telegram", connectionId, chatId },
      text,
      receivedAt: DateTime.formatIso(
        DateTime.makeUnsafe(Math.max(0, Math.min(message.date, MAX_DATE_SECONDS)) * 1000),
      ),
    },
  };
}
