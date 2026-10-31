import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChannelDeliveryErrorCode } from "./channels.ts";

/**
 * Settings and status for the Slack connection. Tokens are write-only: they go in through
 * configure and never come back out; responses only say whether one is stored.
 */

export const SlackChannelConnectionId = TrimmedNonEmptyString.pipe(
  Schema.brand("SlackChannelConnectionId"),
);
export type SlackChannelConnectionId = typeof SlackChannelConnectionId.Type;

export const SlackChannelConnectionStatus = Schema.Literals([
  "disabled",
  "connecting",
  "connected",
  "reconnecting",
  "error",
]);
export type SlackChannelConnectionStatus = typeof SlackChannelConnectionStatus.Type;

/** Slack conversation ids: public/private channels (`C…`, `G…`). */
export const SlackChannelId = TrimmedNonEmptyString.check(Schema.isPattern(/^[CG][A-Z0-9]{8,31}$/));
export type SlackChannelId = typeof SlackChannelId.Type;

/** The most recent failed delivery, without secrets or the raw Slack response. */
export const SlackChannelDeliveryError = Schema.Struct({
  code: ChannelDeliveryErrorCode,
  at: IsoDateTime,
  channelId: Schema.optional(TrimmedNonEmptyString),
});
export type SlackChannelDeliveryError = typeof SlackChannelDeliveryError.Type;

export const SlackChannelSettings = Schema.Struct({
  connectionId: SlackChannelConnectionId,
  enabled: Schema.Boolean,
  hasAppToken: Schema.Boolean,
  hasBotToken: Schema.Boolean,
  teamId: Schema.optional(TrimmedNonEmptyString),
  botUserId: Schema.optional(TrimmedNonEmptyString),
  allowedChannelIds: Schema.Array(SlackChannelId),
  status: SlackChannelConnectionStatus,
  /** A fixed reason; never contains a token. */
  lastError: Schema.optional(Schema.String),
  lastDeliveryError: Schema.optional(SlackChannelDeliveryError),
});
export type SlackChannelSettings = typeof SlackChannelSettings.Type;

/**
 * Omitted fields keep their stored value. `clearCredentials: true` disconnects and deletes
 * both tokens and cannot be combined with new ones.
 */
export const SlackChannelConfigureInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  appToken: Schema.optional(TrimmedNonEmptyString),
  botToken: Schema.optional(TrimmedNonEmptyString),
  allowedChannelIds: Schema.optional(Schema.Array(SlackChannelId)),
  clearCredentials: Schema.optional(Schema.Boolean),
});
export type SlackChannelConfigureInput = typeof SlackChannelConfigureInput.Type;

export const SlackChannelGetSettingsInput = Schema.Struct({});
export const SlackChannelDisconnectInput = Schema.Struct({});
export const SlackChannelSubscribeStatusInput = Schema.Struct({});

export const SlackChannelStatusEvent = Schema.Struct({
  connectionId: SlackChannelConnectionId,
  status: SlackChannelConnectionStatus,
  teamId: Schema.optional(TrimmedNonEmptyString),
  botUserId: Schema.optional(TrimmedNonEmptyString),
  lastError: Schema.optional(Schema.String),
  lastDeliveryError: Schema.optional(SlackChannelDeliveryError),
});
export type SlackChannelStatusEvent = typeof SlackChannelStatusEvent.Type;

export const ChannelsCreateLinkCodeInput = Schema.Struct({
  connectionId: SlackChannelConnectionId,
});
export const ChannelsListIdentitiesInput = Schema.Struct({
  connectionId: SlackChannelConnectionId,
});
export const ChannelsUnlinkInput = Schema.Struct({
  connectionId: SlackChannelConnectionId,
  externalActorId: TrimmedNonEmptyString,
});
export const ChannelsUnlinkResult = Schema.Struct({});

const SLACK_CHANNEL_FAILURE_MESSAGES = {
  adapter_unavailable: "Slack is not available on this server.",
  invalid_input: "The Slack settings are not valid.",
  invalid_token: "Slack rejected the token.",
  persistence_failed: "Could not save the Slack settings.",
} as const;

export const SlackChannelSettingsErrorReason = Schema.Literals(
  Object.keys(SLACK_CHANNEL_FAILURE_MESSAGES) as Array<keyof typeof SLACK_CHANNEL_FAILURE_MESSAGES>,
);
export type SlackChannelSettingsErrorReason = typeof SlackChannelSettingsErrorReason.Type;

/** Safe to show: never contains a token or a raw Slack response, and carries no `cause`. */
export class SlackChannelSettingsError extends Schema.TaggedError<SlackChannelSettingsError>()(
  "SlackChannelSettingsError",
  { reason: SlackChannelSettingsErrorReason },
) {
  override get message(): string {
    return SLACK_CHANNEL_FAILURE_MESSAGES[this.reason];
  }
}
