import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { ChannelDeliveryErrorCode } from "./channels.ts";

/**
 * Settings and status for talking to assistants through a Telegram bot. Telegram authenticates
 * senders by numeric user id, so only the ids listed here are heard; other private senders wait for approval. The bot token is a secret:
 * clients can set or clear it but never read it back.
 */

export const TelegramChannelStatus = Schema.Literals(["disabled", "running", "error"]);
export type TelegramChannelStatus = typeof TelegramChannelStatus.Type;

/** A fixed reason the channel is not working; never a raw Telegram message. */
export const TelegramChannelErrorCode = Schema.Literals([
  "invalid_token",
  "conflict",
  "unreachable",
  "rate_limited",
]);
export type TelegramChannelErrorCode = typeof TelegramChannelErrorCode.Type;

/** The most recent failed send. */
export const TelegramChannelDeliveryError = Schema.Struct({
  code: ChannelDeliveryErrorCode,
  at: IsoDateTime,
});
export type TelegramChannelDeliveryError = typeof TelegramChannelDeliveryError.Type;

/** Someone who wrote to the bot privately but is not on the list yet. */
export const TelegramPendingSender = Schema.Struct({
  userId: Schema.String,
  firstName: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  lastSeenAt: IsoDateTime,
});
export type TelegramPendingSender = typeof TelegramPendingSender.Type;

export const TelegramChannelSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** Whether a bot token is stored; the token itself never leaves the server. */
  tokenConfigured: Schema.Boolean,
  /** Numeric Telegram user ids whose private messages to the bot are heard. */
  allowedUserIds: Schema.Array(Schema.String),
  /** The bot's @username, known once the token was accepted. */
  botUsername: Schema.optional(Schema.String),
  status: TelegramChannelStatus,
  lastError: Schema.optional(TelegramChannelErrorCode),
  lastDeliveryError: Schema.optional(TelegramChannelDeliveryError),
  /** Recent unknown senders, newest first; omitted when there are none. */
  pendingSenders: Schema.optional(Schema.Array(TelegramPendingSender)),
});
export type TelegramChannelSettings = typeof TelegramChannelSettings.Type;

const UserIds = Schema.Array(Schema.String.check(Schema.isMaxLength(30))).check(
  Schema.isMaxLength(50),
);

/** Omitted fields keep their stored value. `botToken` replaces the stored token; `clearToken` removes it. */
export const TelegramChannelConfigureInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  allowedUserIds: Schema.optional(UserIds),
  botToken: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  clearToken: Schema.optional(Schema.Boolean),
  /** Forgets these waiting senders; they reappear if they write again. */
  dismissUserIds: Schema.optional(UserIds),
});
export type TelegramChannelConfigureInput = typeof TelegramChannelConfigureInput.Type;

export const TelegramChannelGetSettingsInput = Schema.Struct({});
export const TelegramChannelSubscribeStatusInput = Schema.Struct({});

export const TelegramChannelStatusEvent = Schema.Struct({
  status: TelegramChannelStatus,
  lastError: Schema.optional(TelegramChannelErrorCode),
  lastDeliveryError: Schema.optional(TelegramChannelDeliveryError),
  botUsername: Schema.optional(Schema.String),
  pendingSenders: Schema.optional(Schema.Array(TelegramPendingSender)),
});
export type TelegramChannelStatusEvent = typeof TelegramChannelStatusEvent.Type;

const TELEGRAM_CHANNEL_FAILURE_MESSAGES = {
  invalid_token: "That does not look like a bot token. Copy it from @BotFather.",
  invalid_user_id: "A Telegram user id is a number, such as 123456789.",
  no_token: "Add the bot token before turning Telegram on.",
  persistence_failed: "Could not save the Telegram settings.",
} as const;

export const TelegramChannelSettingsErrorReason = Schema.Literals(
  Object.keys(TELEGRAM_CHANNEL_FAILURE_MESSAGES) as Array<
    keyof typeof TELEGRAM_CHANNEL_FAILURE_MESSAGES
  >,
);
export type TelegramChannelSettingsErrorReason = typeof TelegramChannelSettingsErrorReason.Type;

/** Safe to show. `detail` names the user id that was rejected; it never holds the token. */
export class TelegramChannelSettingsError extends Schema.TaggedError<TelegramChannelSettingsError>()(
  "TelegramChannelSettingsError",
  {
    reason: TelegramChannelSettingsErrorReason,
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return TELEGRAM_CHANNEL_FAILURE_MESSAGES[this.reason];
  }
}
