import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Messages from chat apps (Slack) to assistants and back. A transport turns its events into a
 * `ChannelInboundMessage` for the gateway and delivers `ChannelOutboundMessage`s it is handed.
 */

export const ChannelKind = Schema.Literals(["slack"]);
export type ChannelKind = typeof ChannelKind.Type;

/** Where a reply goes. Without `rootTs` a Slack reply is a top-level message (direct messages). */
export const ChannelReplyAddress = Schema.Struct({
  kind: Schema.Literal("slack"),
  connectionId: TrimmedNonEmptyString,
  teamId: TrimmedNonEmptyString,
  channelId: TrimmedNonEmptyString,
  rootTs: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelReplyAddress = typeof ChannelReplyAddress.Type;

/** What a transport observed about the sender. Never a source of permissions on its own. */
export const ChannelActorRef = Schema.Struct({
  externalActorId: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelActorRef = typeof ChannelActorRef.Type;

/**
 * Why a transport could not deliver. Rate limits come with a retry delay. Timeouts and network
 * errors leave the outcome unknown. `not_in_channel`, `channel_not_found`, `invalid_auth`,
 * and `token_revoked` do not get better on retry.
 */
export const ChannelDeliveryErrorCode = Schema.Literals([
  "rate_limited",
  "not_in_channel",
  "channel_not_found",
  "invalid_auth",
  "token_revoked",
  "timeout",
  "network",
  "unknown",
]);
export type ChannelDeliveryErrorCode = typeof ChannelDeliveryErrorCode.Type;

export const ChannelInboundMessage = Schema.Struct({
  kind: ChannelKind,
  connectionId: TrimmedNonEmptyString,
  /** The scope an assistant stays picked in: a Slack DM or channel. */
  conversationKey: TrimmedNonEmptyString,
  externalMessageId: TrimmedNonEmptyString,
  /** The same key is handled once, so a redelivered event never runs twice. */
  idempotencyKey: TrimmedNonEmptyString,
  actor: ChannelActorRef,
  replyAddress: ChannelReplyAddress,
  text: Schema.String,
  receivedAt: IsoDateTime,
  /** Set when the message is a button press; carries the button's value. */
  choiceValue: Schema.optional(TrimmedNonEmptyString),
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
  /** The person to tag, such as a Slack user id. */
  mentionActorId: Schema.optional(TrimmedNonEmptyString),
  /** Buttons under the message; transports without buttons list them in the text. */
  choices: Schema.optional(Schema.Array(ChannelChoice)),
  /** Edits this earlier message instead of posting a new one (a card that was answered). */
  replacesExternalMessageId: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelOutboundMessage = typeof ChannelOutboundMessage.Type;

export const ChannelDeliveryReceipt = Schema.Struct({
  deliveryId: TrimmedNonEmptyString,
  acceptedAt: IsoDateTime,
  externalMessageId: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelDeliveryReceipt = typeof ChannelDeliveryReceipt.Type;

/** Sent by a transport when someone replies `link <code>`; never stored as a message. */
export const ChannelIdentityLinkConsumeInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  externalActorId: TrimmedNonEmptyString,
  code: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
  replyAddress: ChannelReplyAddress,
});
export type ChannelIdentityLinkConsumeInput = typeof ChannelIdentityLinkConsumeInput.Type;

/** A one-time code someone sends the bot as `link <code>` to link their chat account. */
export const ChannelLinkCode = Schema.Struct({
  code: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ChannelLinkCode = typeof ChannelLinkCode.Type;

export const ChannelLinkedIdentity = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  externalActorId: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  linkedAt: IsoDateTime,
});
export type ChannelLinkedIdentity = typeof ChannelLinkedIdentity.Type;

export const ChannelNoticeKind = Schema.Literals(["link_help", "link_invalid"]);
export type ChannelNoticeKind = typeof ChannelNoticeKind.Type;

/** A fixed notice a transport asks for, such as help for a `link` command without a code. */
export const ChannelNoticeInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
  replyAddress: ChannelReplyAddress,
  actor: ChannelActorRef,
  notice: ChannelNoticeKind,
});
export type ChannelNoticeInput = typeof ChannelNoticeInput.Type;

const CHANNEL_GATEWAY_FAILURE_MESSAGES = {
  identity_unlinked: "This account is not linked yet.",
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

/** Safe to show: never carries message text, tokens or link codes. */
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
