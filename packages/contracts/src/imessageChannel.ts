import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { ChannelDeliveryErrorCode } from "./channels.ts";

/**
 * Settings and status for talking to assistants over iMessage on the Mac that runs the server.
 * Apple authenticates senders, so there is no linking: only the handles listed here are heard.
 */

export const ImessageChannelStatus = Schema.Literals(["disabled", "running", "error"]);
export type ImessageChannelStatus = typeof ImessageChannelStatus.Type;

/** A fixed reason the channel is not working; never a raw system message. */
export const ImessageChannelErrorCode = Schema.Literals([
  "full_disk_access_missing",
  "database_unavailable",
  "automation_denied",
  "messages_not_signed_in",
]);
export type ImessageChannelErrorCode = typeof ImessageChannelErrorCode.Type;

/** The most recent failed send. */
export const ImessageChannelDeliveryError = Schema.Struct({
  code: ChannelDeliveryErrorCode,
  at: IsoDateTime,
});
export type ImessageChannelDeliveryError = typeof ImessageChannelDeliveryError.Type;

const Handle = Schema.String.check(Schema.isMaxLength(200));
const Handles = Schema.Array(Handle).check(Schema.isMaxLength(50));

export const ImessageChannelSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** Phone numbers (E.164) and emails of other accounts whose messages are heard. */
  allowedHandles: Schema.Array(Schema.String),
  /** The user's own numbers and emails; their chat with themselves is heard. */
  selfHandles: Schema.Array(Schema.String),
  status: ImessageChannelStatus,
  lastError: Schema.optional(ImessageChannelErrorCode),
  lastDeliveryError: Schema.optional(ImessageChannelDeliveryError),
});
export type ImessageChannelSettings = typeof ImessageChannelSettings.Type;

/** Omitted fields keep their stored value. Handles are normalized by the server. */
export const ImessageChannelConfigureInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  allowedHandles: Schema.optional(Handles),
  selfHandles: Schema.optional(Handles),
});
export type ImessageChannelConfigureInput = typeof ImessageChannelConfigureInput.Type;

export const ImessageChannelGetSettingsInput = Schema.Struct({});
export const ImessageChannelSubscribeStatusInput = Schema.Struct({});
export const ImessageChannelCheckAccessInput = Schema.Struct({});

export const ImessageChannelStatusEvent = Schema.Struct({
  status: ImessageChannelStatus,
  lastError: Schema.optional(ImessageChannelErrorCode),
  lastDeliveryError: Schema.optional(ImessageChannelDeliveryError),
});
export type ImessageChannelStatusEvent = typeof ImessageChannelStatusEvent.Type;

/** Whether the server can read the Messages database: the permission state before enabling. */
export const ImessageChannelAccess = Schema.Literals([
  "ok",
  "full_disk_access_missing",
  "messages_not_signed_in",
  "database_unavailable",
]);
export type ImessageChannelAccess = typeof ImessageChannelAccess.Type;

export const ImessageChannelCheckAccessResult = Schema.Struct({ access: ImessageChannelAccess });
export type ImessageChannelCheckAccessResult = typeof ImessageChannelCheckAccessResult.Type;

const IMESSAGE_CHANNEL_FAILURE_MESSAGES = {
  adapter_unavailable: "iMessage is only available on a Mac.",
  invalid_handle: "That is not a phone number with country code (+...) or an email address.",
  handles_overlap: "A handle cannot be both another account and your own.",
  no_handles: "Add at least one handle before turning iMessage on.",
  persistence_failed: "Could not save the iMessage settings.",
} as const;

export const ImessageChannelSettingsErrorReason = Schema.Literals(
  Object.keys(IMESSAGE_CHANNEL_FAILURE_MESSAGES) as Array<
    keyof typeof IMESSAGE_CHANNEL_FAILURE_MESSAGES
  >,
);
export type ImessageChannelSettingsErrorReason = typeof ImessageChannelSettingsErrorReason.Type;

/** Safe to show. `detail` names the handle that was rejected. */
export class ImessageChannelSettingsError extends Schema.TaggedError<ImessageChannelSettingsError>()(
  "ImessageChannelSettingsError",
  {
    reason: ImessageChannelSettingsErrorReason,
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return IMESSAGE_CHANNEL_FAILURE_MESSAGES[this.reason];
  }
}
