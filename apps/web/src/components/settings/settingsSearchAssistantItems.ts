import {
  AUTONOMY_CHANNEL_LABELS,
  AUTONOMY_RULE_OPTIONS,
  DETECT_PROBLEMS_DESCRIPTION,
  DETECT_PROBLEMS_LABEL,
} from "@t3tools/client-runtime/autonomy";
import {
  SANDBOX_CPU_DESCRIPTION,
  SANDBOX_GITHUB_DESCRIPTION,
  SANDBOX_WHEN_DONE_DESCRIPTION,
} from "@t3tools/client-runtime/state/assistants";
import { CHANNEL_LANGUAGE_DESCRIPTION, type AutonomyRule } from "@t3tools/contracts";
import type { SettingsSearchItem } from "./settingsSearch";

/** Fragments a row draws beside its at-rest sentence; the items list them as search terms. */
export const ASSISTANT_SETTINGS_COPY = {
  telegramTokenSaved:
    "The token is stored on the server and is never shown again. Paste a new one to replace it.",
  imessageFoundFrom: "Messages here sends from",
  chatWithYourself: "Chat with yourself",
  otherAccounts: "Other accounts",
  ownHandlesDescription:
    "Write to yourself in Messages; the assistant answers in the same chat, each reply starting with its name.",
  allowedHandlesDescription:
    "If this Mac's Messages uses an Apple ID of its own, these people can message it.",
} as const;

const CHANNEL_LIMITS_DESCRIPTION =
  "Approvals arrive as numbered choices: reply with the number. Group chats and attachments are not supported, and more than 10 messages a minute from one person are held back.";

const rule = (name: AutonomyRule) => AUTONOMY_RULE_OPTIONS.find((option) => option.rule === name)!;

export const ASSISTANT_SETTINGS_SEARCH_ITEMS = [
  {
    id: "assistants-with-access",
    title: "Assistants with access",
    to: "/settings/projects",
    scope: "project",
  },
  { id: "assistants-groups", title: "Groups", to: "/settings/assistants", targetId: "assistants" },
  {
    id: "assistants-restore-jarvis",
    title: "Jarvis",
    description: "The default assistant was deleted. Restore him to chat with Jarvis again.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "assistants-archived-groups",
    title: "Archived groups",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "assistants-archived",
    title: "Archived",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "assistant-sandbox",
    title: "Sandbox",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "assistant-sandbox-container",
    title: "Sandbox container",
    description:
      "A Linux container (Docker) where assistants set to Sandbox run commands and edit files.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "assistant-sandbox-cpu",
    title: "CPU limit",
    description: SANDBOX_CPU_DESCRIPTION,
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "assistant-sandbox-when-done",
    title: "When a task is done",
    description: SANDBOX_WHEN_DONE_DESCRIPTION,
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "assistant-sandbox-linked",
    title: "Linked environments",
    description:
      "The sandbox is linked to this machine, which needs Linked environments (Settings → Labs). Starting the sandbox turns it on.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "assistant-sandbox-sign-in",
    title: "Sign in to providers in the sandbox",
    description:
      "Providers need their own sign-in inside the sandbox. This opens its Providers settings; it works from the Mac that runs the sandbox.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "assistant-sandbox-github",
    title: "GitHub in the sandbox",
    description: SANDBOX_GITHUB_DESCRIPTION,
    to: "/settings/assistants",
    targetId: "assistants",
  },
  { id: "autonomy", title: "Autonomy", to: "/settings/assistants", targetId: "assistants" },
  {
    id: "autonomy-notify",
    title: "Assistants can notify you",
    description:
      "Assistants set to notify wake on their own and tell you. Turn off to pause every rule and watch.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-detect-problems",
    title: DETECT_PROBLEMS_LABEL,
    description: DETECT_PROBLEMS_DESCRIPTION,
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-notify-waiting",
    title: "Notify me when something is waiting for me",
    description:
      "Approvals, questions, open decisions and paused group tasks reach you directly, with no model and no daily limit. Works for every assistant and thread.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-notify-after",
    title: "Notify after",
    description: "Something answered sooner is not sent.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-rule-run-failed",
    title: rule("runFailed").label,
    description: rule("runFailed").description,
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-rule-waiting-too-long",
    title: rule("waitingTooLong").label,
    description: rule("waitingTooLong").description,
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-rule-stuck",
    title: rule("stuck").label,
    description: rule("stuck").description,
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-rule-ci-failed",
    title: rule("ciFailed").label,
    description: rule("ciFailed").description,
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-rule-review-incomplete",
    title: rule("reviewIncomplete").label,
    description: rule("reviewIncomplete").description,
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-waiting-after",
    title: "Waiting for you after",
    description:
      "How long a run may wait on your answer before an assistant wakes to look into it.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-stuck-after",
    title: "Stuck after",
    description: "How long a run may show no activity before it looks stuck.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-wakes-per-day",
    title: "Notifications per day",
    description: "Assistants stop waking after this many in a day.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-messages-per-day",
    title: "Messages from assistants per day",
    description: "How many short messages each assistant can send you on its own.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-notify-telegram",
    title: `Notify on ${AUTONOMY_CHANNEL_LABELS.telegram}`,
    description: "Send the answer to the first allowed Telegram user.",
    to: "/settings/assistants",
    targetId: "assistants",
  },
  {
    id: "autonomy-notify-t3",
    title: `Notify on ${AUTONOMY_CHANNEL_LABELS.t3}`,
    description: "Show the answer in Activity, on every device.",
    to: "/settings/assistants",
    targetId: "assistants",
  },

  {
    id: "channel-language-telegram",
    title: "Language",
    description: CHANNEL_LANGUAGE_DESCRIPTION,
    to: "/settings/telegram",
    targetId: "telegram",
  },
  {
    id: "channel-language-imessage",
    title: "Language",
    description: CHANNEL_LANGUAGE_DESCRIPTION,
    to: "/settings/imessage",
    targetId: "imessage",
  },

  { id: "telegram-status", title: "Status", to: "/settings/telegram", targetId: "telegram" },
  {
    id: "telegram-use",
    title: "Use Telegram",
    description: "Answer messages from the people you allow.",
    to: "/settings/telegram",
    targetId: "telegram",
  },
  {
    id: "telegram-bot-token",
    title: "Bot token",
    description: "Paste the token @BotFather gave you.",
    to: "/settings/telegram",
    targetId: "telegram",
    searchTerms: [ASSISTANT_SETTINGS_COPY.telegramTokenSaved],
  },
  {
    id: "telegram-remove-token",
    title: "Remove the token",
    description: "Turns Telegram off and forgets the token on this server.",
    to: "/settings/telegram",
    targetId: "telegram",
  },
  {
    id: "telegram-waiting",
    title: "Waiting for approval",
    to: "/settings/telegram",
    targetId: "telegram",
  },
  {
    id: "telegram-pending-senders",
    title: "People who wrote to the bot",
    description: "Their messages are not passed on until you allow them.",
    to: "/settings/telegram",
    targetId: "telegram",
  },
  {
    id: "telegram-who-can-write",
    title: "Who can write to the bot",
    to: "/settings/telegram",
    targetId: "telegram",
  },
  {
    id: "telegram-user-ids",
    title: "Telegram user ids",
    description:
      "Only these people are heard. Allow someone from the waiting list above, or add their number here.",
    to: "/settings/telegram",
    targetId: "telegram",
  },
  { id: "telegram-setup", title: "Set up a bot", to: "/settings/telegram" },
  {
    id: "telegram-setup-create",
    title: "1. Create the bot",
    description:
      "In Telegram, open @BotFather and send /newbot. Pick a name and a username; it replies with the bot token.",
    to: "/settings/telegram",
  },
  {
    id: "telegram-setup-token",
    title: "2. Paste the token and turn it on",
    description: "Save the token above, then switch on Use Telegram.",
    to: "/settings/telegram",
  },
  {
    id: "telegram-setup-message",
    title: "3. Message the bot",
    description:
      "Open your bot, press Start and say hello. You then show up under Waiting for approval here.",
    to: "/settings/telegram",
  },
  {
    id: "telegram-setup-allow",
    title: "4. Allow yourself",
    description: "Press Allow next to your name. Then send @ to see your assistants.",
    to: "/settings/telegram",
  },
  { id: "telegram-good-to-know", title: "Good to know", to: "/settings/telegram" },
  {
    id: "telegram-limits",
    title: "Approvals and limits",
    description: CHANNEL_LIMITS_DESCRIPTION,
    to: "/settings/telegram",
  },

  { id: "imessage-access", title: "Access", to: "/settings/imessage", targetId: "imessage" },
  {
    id: "imessage-full-disk-access",
    title: "Full Disk Access",
    description: "T3 Code can read your messages on this Mac.",
    to: "/settings/imessage",
    targetId: "imessage",
  },
  { id: "imessage-status", title: "Status", to: "/settings/imessage", targetId: "imessage" },
  {
    id: "imessage-use",
    title: "Use iMessage",
    description: "Answer messages from the people listed below.",
    to: "/settings/imessage",
    targetId: "imessage",
  },
  {
    id: "imessage-found-on-mac",
    title: "Found on this Mac",
    description: `${ASSISTANT_SETTINGS_COPY.imessageFoundFrom} your phone numbers and emails.`,
    to: "/settings/imessage",
    targetId: "imessage",
  },
  {
    id: "imessage-own-handles",
    title: "Your phone numbers and emails",
    description: ASSISTANT_SETTINGS_COPY.ownHandlesDescription,
    to: "/settings/imessage",
    targetId: "imessage",
    searchTerms: [ASSISTANT_SETTINGS_COPY.chatWithYourself],
  },
  {
    id: "imessage-allowed-handles",
    title: "Allowed phone numbers and emails",
    description: ASSISTANT_SETTINGS_COPY.allowedHandlesDescription,
    to: "/settings/imessage",
    targetId: "imessage",
    searchTerms: [ASSISTANT_SETTINGS_COPY.otherAccounts],
  },
  { id: "imessage-good-to-know", title: "Good to know", to: "/settings/imessage" },
  {
    id: "imessage-limits",
    title: "Approvals and limits",
    description: CHANNEL_LIMITS_DESCRIPTION,
    to: "/settings/imessage",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
