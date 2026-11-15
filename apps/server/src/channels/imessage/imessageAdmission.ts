// @effect-diagnostics nodeBuiltinImport:off -- a synchronous SHA-256 keeps admission a pure function.
import * as NodeCrypto from "node:crypto";

import type { ChannelInboundMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ImessageRow } from "./imessageChatDb.ts";
import { normalizeHandle } from "./imessageHandles.ts";

const MAX_ARCHIVE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const marker = new TextEncoder().encode("NSString");
const APPLE_EPOCH_MS = 978_307_200_000;
/** Apple stores the same message twice in a self chat, a few seconds apart at most. */
const MIRROR_WINDOW_MS = 5_000;
/** How long after sending a reply its echo can still be told apart from a new message. */
export const OWN_REPLY_WINDOW_MS = 30 * 60_000;

/** The text of a message whose `text` column is empty: the NSString inside the typedstream blob. */
export function extractTypedstreamText(
  body: Uint8Array | null,
  maxBytes = MAX_ARCHIVE_BYTES,
): string | undefined {
  if (body === null || body.length > maxBytes) return undefined;
  for (let i = 0; i + marker.length + 2 < body.length; i += 1) {
    if (!marker.every((byte, offset) => body[i + offset] === byte)) continue;
    let start = i + marker.length;
    // The payload follows a typedstream '+' marker.
    while (start < body.length && body[start] !== 0x2b && start < i + marker.length + 16)
      start += 1;
    if (body[start] !== 0x2b) return undefined;
    start += 1;
    const head = body[start++];
    if (head === undefined) return undefined;
    let size: number;
    if (head < 0x80) size = head;
    else if (head === 0x81) {
      if (start + 2 > body.length) return undefined;
      size = body[start]! | (body[start + 1]! << 8);
      start += 2;
    } else if (head === 0x82) {
      if (start + 4 > body.length) return undefined;
      size =
        body[start]! |
        (body[start + 1]! << 8) |
        (body[start + 2]! << 16) |
        (body[start + 3]! << 24);
      start += 4;
    } else return undefined;
    if (size <= 0 || size > MAX_TEXT_BYTES || start + size > body.length) return undefined;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(start, start + size));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Apple dates are nanoseconds (modern) or seconds (old) since 2001; undefined when out of range. */
export function appleDateToEpochMs(date: number): number | undefined {
  const epochMs = (date > 100_000_000_000 ? date / 1_000_000 : date * 1_000) + APPLE_EPOCH_MS;
  return Number.isFinite(epochMs) && epochMs >= APPLE_EPOCH_MS && epochMs <= 7_258_118_400_000
    ? epochMs
    : undefined;
}

export const appleDateToIso = (date: number, rowId: number) =>
  DateTime.formatIso(
    DateTime.makeUnsafe(
      appleDateToEpochMs(date) ?? APPLE_EPOCH_MS + Math.max(0, Math.min(rowId, 10_000_000_000)),
    ),
  );

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();
export const fingerprintText = (text: string) =>
  NodeCrypto.createHash("sha256").update(normalizeText(text)).digest("hex");

export interface ImessageAdmissionConfig {
  readonly allowedHandles: ReadonlySet<string>;
  readonly selfHandles: ReadonlySet<string>;
}

/** What the transport sent recently and what a self chat already showed, to tell echoes from input. */
export interface ImessageAdmissionMemory {
  readonly sent: ReadonlyArray<{
    readonly id: number;
    readonly chatGuid: string;
    readonly textHash: string;
    readonly sentAtMs: number;
  }>;
  readonly seen: ReadonlyArray<{
    readonly chatGuid: string;
    readonly textHash: string;
    readonly dateMs: number;
  }>;
}

export interface ImessageSeenEntry {
  readonly chatGuid: string;
  readonly textHash: string;
  readonly dateMs: number;
}

interface SelfChatEffects {
  /** A reply this transport sent, now matched with its echo and used up. */
  readonly consumeSentId?: number;
  /** Remembered so the twin copy of this message is skipped. */
  readonly remember: ImessageSeenEntry;
}

export type ImessageAdmission =
  | ({ readonly type: "skip"; readonly reason: string } & Partial<SelfChatEffects>)
  | { readonly type: "pending_join"; readonly rowId: number }
  | ({
      readonly type: "message";
      readonly rowId: number;
      readonly guid: string;
      readonly chatGuid: string;
      readonly senderHandle: string;
      readonly text: string;
      /** It carried an attachment this channel cannot pass on; the sender is told so. */
      readonly attachment?: true;
      readonly receivedAt: string;
      readonly via: "other_account" | "self_chat";
    } & Partial<SelfChatEffects>);

const skip = (reason: string): ImessageAdmission => ({ type: "skip", reason });

/**
 * Decides whether a chat.db row is something the user said to their assistants. Two ways in:
 * a message from an allowed handle (the Mac's Messages has an account of its own), or the user's
 * chat with themselves (the Mac shares the phone's Apple ID). Everything else is ignored,
 * including everything the user sends to anyone else.
 */
export function admitImessageRow(
  row: ImessageRow,
  config: ImessageAdmissionConfig,
  memory: ImessageAdmissionMemory,
): ImessageAdmission {
  if (
    row.item_type !== 0 ||
    (row.associated_message_type !== null && row.associated_message_type !== 0) ||
    row.balloon_bundle_id !== null
  ) {
    return skip("unsupported_kind");
  }
  const fromMe = row.is_from_me !== 0;
  const sender = row.sender_handle === null ? undefined : normalizeHandle(row.sender_handle);
  const fromOther =
    !fromMe &&
    sender !== undefined &&
    config.allowedHandles.has(sender) &&
    !config.selfHandles.has(sender);
  const fromSelf = fromMe || (sender !== undefined && config.selfHandles.has(sender));
  if (!row.guid || (!fromOther && !fromSelf)) return skip("sender");
  const raw = row.text ?? extractTypedstreamText(row.attributedBody);
  // Attachments are not read from chat.db; the message is still admitted so it gets an answer.
  const attachment = Boolean(row.cache_has_attachments) || raw?.includes("￼") === true;
  const text = raw?.replaceAll("￼", "").trim() ?? "";
  if (!text && !attachment) return skip("text");
  if (row.chat_join_count === 0) return { type: "pending_join", rowId: row.rowid };
  if (row.chat_join_count !== 1 || row.style !== 45 || !row.chat_guid) return skip("chat");
  const base = {
    type: "message" as const,
    rowId: row.rowid,
    guid: row.guid,
    chatGuid: row.chat_guid,
    text,
    ...(attachment ? { attachment: true as const } : {}),
    receivedAt: appleDateToIso(row.date, row.rowid),
  };
  if (fromOther) {
    if (row.sender_service !== "iMessage") return skip("service");
    return { ...base, senderHandle: sender, via: "other_account" };
  }
  const chatHandle =
    row.chat_identifier === null ? undefined : normalizeHandle(row.chat_identifier);
  if (chatHandle === undefined || !config.selfHandles.has(chatHandle)) return skip("other_chat");
  if (row.message_service !== "iMessage") return skip("service");
  const dateMs = appleDateToEpochMs(row.date) ?? 0;
  const textHash = fingerprintText(text);
  const remember = { chatGuid: row.chat_guid, textHash, dateMs };
  // Your chats with yourself are one conversation: a reply sent to your number echoes in that chat.
  const own = memory.sent.find(
    (sent) =>
      sent.textHash === textHash &&
      dateMs >= sent.sentAtMs - MIRROR_WINDOW_MS &&
      dateMs <= sent.sentAtMs + OWN_REPLY_WINDOW_MS,
  );
  if (own !== undefined)
    return { type: "skip", reason: "own_reply", consumeSentId: own.id, remember };
  if (
    memory.seen.some(
      (seen) => seen.textHash === textHash && Math.abs(seen.dateMs - dateMs) <= MIRROR_WINDOW_MS,
    )
  ) {
    return skip("mirrored");
  }
  // Messages sends from the Mac's own login. Answering on your other address makes the reply
  // read as incoming on your phone, and every chat with yourself becomes that one conversation.
  const macHandle =
    row.account === null ? undefined : normalizeHandle(row.account.replace(/^[a-z]+:/i, ""));
  const replyHandle =
    macHandle === undefined
      ? chatHandle
      : ([chatHandle, ...config.selfHandles].find((handle) => handle !== macHandle) ?? chatHandle);
  return {
    ...base,
    ...(replyHandle === chatHandle
      ? {}
      : { chatGuid: row.chat_guid.replace(/;-;[^;]+$/, `;-;${replyHandle}`) }),
    senderHandle: chatHandle,
    via: "self_chat",
    remember,
  };
}

export function toImessageInbound(
  input: Extract<ImessageAdmission, { type: "message" }>,
  connectionId: string,
): ChannelInboundMessage {
  return {
    kind: "imessage",
    connectionId,
    conversationKey: input.chatGuid,
    externalMessageId: input.guid,
    idempotencyKey: `${connectionId}:${input.guid}`,
    actor: { externalActorId: input.senderHandle },
    replyAddress: { kind: "imessage", connectionId, chatGuid: input.chatGuid },
    text: input.text,
    ...(input.attachment ? { attachmentProblem: "unsupported" as const } : {}),
    receivedAt: input.receivedAt,
  };
}
