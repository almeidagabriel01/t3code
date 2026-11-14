import { type ChannelInboundMessage, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { safeName } from "../../guest/guestAttachments.ts";
import type { TelegramMessage, TelegramUpdate } from "./telegramApi.ts";

/** The latest date worth representing, in seconds; a message dated beyond it is clamped. */
const MAX_DATE_SECONDS = 4_102_444_800;

/** A file to download; what it really is, its bytes decide. */
export interface TelegramMedia {
  readonly fileId: string;
  /** For display only; the stored file is named by its id. */
  readonly name: string;
}

export type TelegramAdmission =
  | { readonly type: "skip"; readonly reason: "kind" | "chat" | "sender" | "text" }
  | {
      readonly type: "unknown_sender";
      readonly chatId: string;
      readonly sender: {
        readonly userId: string;
        readonly firstName?: string;
        readonly username?: string;
      };
    }
  | {
      readonly type: "message";
      readonly inbound: ChannelInboundMessage;
      readonly media: ReadonlyArray<TelegramMedia>;
      /** Photos sent together arrive one update each, sharing this id. */
      readonly mediaGroupId?: string;
    };

const IMAGE_FILE_NAME = /\.(?:png|jpe?g|webp|gif|heic|heif)$/i;
const fits = (size: number | undefined) => (size ?? 0) <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;

/** The image a message carries, `unsupported` for anything else it carries, or none. */
function mediaOf(message: TelegramMessage): TelegramMedia | "unsupported" | undefined {
  const largest = message.photo?.reduce((best, size) =>
    (size.file_size ?? size.width * size.height) > (best.file_size ?? best.width * best.height)
      ? size
      : best,
  );
  if (largest !== undefined) {
    return fits(largest.file_size) ? { fileId: largest.file_id, name: "photo.jpg" } : "unsupported";
  }
  const document = message.document;
  if (document !== undefined) {
    const name = document.file_name?.split(/[\\/]/).at(-1) ?? "";
    const image =
      document.mime_type?.toLowerCase().startsWith("image/") === true || IMAGE_FILE_NAME.test(name);
    return image && fits(document.file_size)
      ? { fileId: document.file_id, name: safeName(name, "image") }
      : "unsupported";
  }
  return message.text === undefined ? "unsupported" : undefined;
}

/**
 * Decides whether an update is something an allowed person said to the bot in a private chat.
 * Unknown people are reported so the owner can allow them; groups and bots are ignored. Images go
 * on for download with the caption as text; anything else is marked so its sender is told.
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
  if (from === undefined || from.is_bot === true) return { type: "skip", reason: "sender" };
  if (!allowedUserIds.has(String(from.id))) {
    const firstName = from.first_name?.trim();
    const username = from.username?.trim();
    return {
      type: "unknown_sender",
      chatId: String(message.chat.id),
      sender: {
        userId: String(from.id),
        ...(firstName ? { firstName } : {}),
        ...(username ? { username } : {}),
      },
    };
  }
  const media = mediaOf(message);
  const raw = (message.text ?? message.caption)?.trim() ?? "";
  if (!raw && media === undefined) return { type: "skip", reason: "text" };
  const text = message.text !== undefined && /^\/start(?:@\w+)?(?:\s|$)/i.test(raw) ? "@" : raw;
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
      ...(media === "unsupported" ? { attachmentProblem: "unsupported" as const } : {}),
      receivedAt: DateTime.formatIso(
        DateTime.makeUnsafe(Math.max(0, Math.min(message.date, MAX_DATE_SECONDS)) * 1000),
      ),
    },
    media: media === undefined || media === "unsupported" ? [] : [media],
    ...(message.media_group_id === undefined ? {} : { mediaGroupId: message.media_group_id }),
  };
}
