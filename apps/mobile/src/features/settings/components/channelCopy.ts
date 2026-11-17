import { CHANNEL_LANGUAGE_DESCRIPTION, CHANNEL_LANGUAGE_OPTIONS } from "@t3tools/contracts";
import { UNDELIVERED_RESEND_TITLE } from "@t3tools/client-runtime/state/channelUndelivered";

/** What the iMessage and Telegram pages share; Settings search reads these same strings. */
export const CHANNEL_LANGUAGE_TITLE = "Language";

export const CHANNEL_GOOD_TO_KNOW = {
  title: "Good to know",
  approvals: {
    title: "Approvals",
    description: "Approvals arrive as numbered choices. Reply with the number.",
  },
  limits: {
    title: "Limits",
    description:
      "Group chats and attachments are not supported, and more than 10 messages a minute from one person are held back.",
  },
} as const;

export const CHANNEL_SHARED_LABELS: readonly string[] = [
  CHANNEL_LANGUAGE_TITLE,
  CHANNEL_LANGUAGE_DESCRIPTION,
  ...CHANNEL_LANGUAGE_OPTIONS.map(({ label }) => label),
  UNDELIVERED_RESEND_TITLE,
  CHANNEL_GOOD_TO_KNOW.title,
  ...[CHANNEL_GOOD_TO_KNOW.approvals, CHANNEL_GOOD_TO_KNOW.limits].flatMap(
    ({ title, description }) => [title, description],
  ),
];
