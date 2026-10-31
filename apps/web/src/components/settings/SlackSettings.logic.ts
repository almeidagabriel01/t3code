import { SlackChannelId, type SlackChannelSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { formatRelativeTimeLabel } from "../../timestampFormat";

const ERROR_COPY: Readonly<Record<string, string>> = {
  token_revoked: "Slack revoked a token. Create new tokens and save them again.",
  app_uninstalled:
    "The Slack app was removed from the workspace. Install it again and save the new bot token.",
  invalid_token: "Slack rejected a saved token. Check both tokens and save them again.",
  workspace_mismatch:
    "The two tokens belong to different Slack workspaces. Use tokens from the same app.",
  missing_token: "A token is missing. Save both tokens to connect.",
};

export function slackStatusLabel(
  settings: Pick<SlackChannelSettings, "status" | "teamId" | "lastError">,
): string {
  switch (settings.status) {
    case "disabled":
      return "Off";
    case "connecting":
      return "Connecting…";
    case "connected":
      return settings.teamId ? `Connected to ${settings.teamId}` : "Connected";
    case "reconnecting":
      return "Reconnecting…";
    case "error":
      return (
        (settings.lastError && ERROR_COPY[settings.lastError]) ||
        "Slack could not connect. Check the tokens and try again."
      );
  }
}

const DELIVERY_COPY: Readonly<Record<string, string>> = {
  rate_limited: "Slack is rate limiting replies",
  not_in_channel: "the bot is not in that channel, invite it first",
  channel_not_found: "the channel was not found",
  invalid_auth: "Slack rejected the bot token",
  token_revoked: "the bot token was revoked",
  timeout: "Slack did not answer in time",
  network: "of a network problem",
  unknown: "of an unknown error",
};

export function slackDeliveryErrorLabel(
  error: NonNullable<SlackChannelSettings["lastDeliveryError"]>,
  nowMs: number = Date.now(),
): string {
  const when = formatRelativeTimeLabel(error.at, nowMs);
  return `The last reply was not delivered (${when ? `${when}, ` : ""}${DELIVERY_COPY[error.code] ?? DELIVERY_COPY.unknown}).`;
}

const isChannelId = Schema.is(SlackChannelId);

export function parseChannelId(
  input: string,
  existing: ReadonlyArray<string>,
): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string } {
  const id = input.trim().toUpperCase();
  if (!isChannelId(id)) {
    return { ok: false, message: "Enter a channel ID such as C0123456789. It starts with C or G." };
  }
  return existing.includes(id)
    ? { ok: false, message: "That channel is already on the list." }
    : { ok: true, id };
}

export const SLACK_APP_MANIFEST = `display_information:
  name: Jarvis
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Jarvis
    always_online: true
oauth_config:
  scopes:
    bot: [app_mentions:read, chat:write, im:history]
settings:
  event_subscriptions:
    bot_events: [app_mention, message.im]
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
`;
