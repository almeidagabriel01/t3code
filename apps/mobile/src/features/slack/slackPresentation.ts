import type { SlackChannelSettings } from "@t3tools/contracts";

export const SLACK_LINK_INSTRUCTION = (code: string) =>
  `Send \`link ${code}\` to the bot in a direct message.`;

const ERROR_SENTENCES: Record<string, string> = {
  token_revoked: "Slack revoked a token. Save new tokens to reconnect.",
  app_uninstalled: "The Slack app was uninstalled from the workspace.",
  invalid_token: "Slack rejected a token. Check the App token and the Bot token.",
  workspace_mismatch: "These tokens belong to different Slack workspaces.",
  missing_token: "Both tokens are needed to connect.",
};

const DELIVERY_SENTENCES: Record<string, string> = {
  rate_limited: "Slack is rate limiting replies.",
  not_in_channel: "The bot is not in the channel it tried to reply in.",
  channel_not_found: "The channel it tried to reply in was not found.",
  invalid_auth: "Slack rejected the Bot token while replying.",
  token_revoked: "Slack revoked the Bot token while replying.",
  timeout: "Slack took too long to accept a reply.",
  network: "A reply could not reach Slack.",
  unknown: "A reply could not be delivered.",
};

export function slackStatusLabel(settings: SlackChannelSettings): string {
  switch (settings.status) {
    case "disabled":
      return "Off";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "connected":
      return `Connected to ${settings.teamId ?? "Slack"}`;
    case "error":
      return settings.lastError
        ? (ERROR_SENTENCES[settings.lastError] ?? "Slack could not connect.")
        : "Slack could not connect.";
  }
}

/** A failed reply shown beside the status; null when the last delivery worked. */
export function slackDeliveryNote(settings: SlackChannelSettings): string | null {
  const error = settings.lastDeliveryError;
  return error ? (DELIVERY_SENTENCES[error.code] ?? DELIVERY_SENTENCES.unknown!) : null;
}

/** The normalized channel id, or why it cannot be added. */
export function parseSlackChannelId(
  input: string,
  existing: ReadonlyArray<string>,
): { readonly id: string } | { readonly error: string } {
  const id = input.trim().toUpperCase();
  if (!/^[CG][A-Z0-9]{8,31}$/.test(id)) {
    return { error: "A channel ID starts with C or G, like C0123456789." };
  }
  return existing.includes(id) ? { error: "That channel is already added." } : { id };
}

export const SLACK_MANIFEST = `display_information:
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
