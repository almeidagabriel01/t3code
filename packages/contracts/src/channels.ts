import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Messages from chat apps (iMessage, Telegram) to assistants and back. A transport turns its events into a
 * `ChannelInboundMessage` for the gateway and delivers `ChannelOutboundMessage`s it is handed.
 */

export const ChannelKind = Schema.Literals(["imessage", "telegram"]);
export type ChannelKind = typeof ChannelKind.Type;

/** Where a reply goes: an iMessage chat by its Messages chat guid, or a Telegram chat by its id. */
export const ChannelReplyAddress = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("imessage"),
    connectionId: TrimmedNonEmptyString,
    chatGuid: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("telegram"),
    connectionId: TrimmedNonEmptyString,
    chatId: TrimmedNonEmptyString,
  }),
]);
export type ChannelReplyAddress = typeof ChannelReplyAddress.Type;

/** What a transport observed about the sender. Never a source of permissions on its own. */
export const ChannelActorRef = Schema.Struct({
  externalActorId: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelActorRef = typeof ChannelActorRef.Type;

/**
 * Why a transport could not deliver. A timeout leaves the outcome unknown. The first three do not
 * get better on retry; they need a person to fix the Mac's setup or the chat.
 */
export const ChannelDeliveryErrorCode = Schema.Literals([
  "automation_denied",
  "messages_not_signed_in",
  "chat_not_found",
  "timeout",
  "unknown",
]);
export type ChannelDeliveryErrorCode = typeof ChannelDeliveryErrorCode.Type;

export const ChannelInboundMessage = Schema.Struct({
  kind: ChannelKind,
  connectionId: TrimmedNonEmptyString,
  /** The scope an assistant stays picked in: the chat guid. */
  conversationKey: TrimmedNonEmptyString,
  externalMessageId: TrimmedNonEmptyString,
  /** The same key is handled once, so a redelivered event never runs twice. */
  idempotencyKey: TrimmedNonEmptyString,
  actor: ChannelActorRef,
  replyAddress: ChannelReplyAddress,
  text: Schema.String,
  receivedAt: IsoDateTime,
});
export type ChannelInboundMessage = typeof ChannelInboundMessage.Type;

export const ChannelChoice = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: TrimmedNonEmptyString,
});
export type ChannelChoice = typeof ChannelChoice.Type;

/** One delivery. Delivery is at least once; `deliveryId` stays the same on retry. */
export const ChannelOutboundMessage = Schema.Struct({
  deliveryId: TrimmedNonEmptyString,
  destination: ChannelReplyAddress,
  text: Schema.String,
  /** Who is speaking; every message starts with it so replies read apart from yours in a self chat. */
  senderName: TrimmedNonEmptyString,
  /** Transports without buttons list the choices as a numbered list in the text. */
  choices: Schema.optional(Schema.Array(ChannelChoice)),
  /** The language of T3's own phrases the transport adds, such as the numbered-choices hint. */
  language: Schema.optional(Schema.Literals(["en", "pt-BR"])),
});
export type ChannelOutboundMessage = typeof ChannelOutboundMessage.Type;

export const ChannelDeliveryReceipt = Schema.Struct({
  deliveryId: TrimmedNonEmptyString,
  acceptedAt: IsoDateTime,
  externalMessageId: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelDeliveryReceipt = typeof ChannelDeliveryReceipt.Type;

const CHANNEL_GATEWAY_FAILURE_MESSAGES = {
  invalid_input: "The channel message is not valid.",
  idempotency_conflict: "A different message was already stored under this idempotency key.",
  adapter_unavailable: "This channel is not available on this server.",
  persistence_failed: "Could not store the channel message.",
  delivery_failed: "Could not deliver the channel message.",
  not_found: "The requested channel record does not exist.",
} as const;

export const ChannelGatewayErrorReason = Schema.Literals(
  Object.keys(CHANNEL_GATEWAY_FAILURE_MESSAGES) as Array<
    keyof typeof CHANNEL_GATEWAY_FAILURE_MESSAGES
  >,
);
export type ChannelGatewayErrorReason = typeof ChannelGatewayErrorReason.Type;

/** Safe to show: never carries message text. */
export class ChannelGatewayError extends Schema.TaggedError<ChannelGatewayError>()(
  "ChannelGatewayError",
  {
    reason: ChannelGatewayErrorReason,
    /** Seconds to wait before retrying, when the transport said so. */
    retryAfterSeconds: Schema.optionalKey(PositiveInt),
    /** `not_sent` when the channel certainly did not get it, `unknown` when it may have. */
    deliveryOutcome: Schema.optionalKey(Schema.Literals(["not_sent", "unknown"])),
    deliveryErrorCode: Schema.optionalKey(ChannelDeliveryErrorCode),
  },
) {
  override get message(): string {
    return CHANNEL_GATEWAY_FAILURE_MESSAGES[this.reason];
  }
}

/** The chat a reply address names, whatever the channel calls it. */
export const channelChatKey = (address: ChannelReplyAddress) =>
  address.kind === "imessage" ? address.chatGuid : address.chatId;
