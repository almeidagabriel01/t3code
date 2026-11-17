import { CHANNEL_SHARED_LABELS } from "../settings/components/channelCopy";

/** The Telegram page's fixed labels; Settings search reads these same strings. */
export const TELEGRAM_COPY = {
  intro:
    "Talk to your assistants from Telegram, on any computer. Start with @Name to pick an assistant; Jarvis answers otherwise, and the chat stays with the last one picked. Send @ on its own to list them, or use the / menu in Telegram. It works while T3 Code is running.",
  connection: "Connection",
  use: "Use Telegram",
  botToken: "Bot token",
  tokenSaved: "Token saved",
  noToken: "No token yet",
  tokenFooterSaved:
    "The token is stored on the server and never shown again. Paste a new one to replace it.",
  tokenFooterEmpty: "Paste the token @BotFather gave you.",
  waiting: {
    title: "Waiting for approval",
    footer: "These people wrote to the bot. Their messages are not passed on until you allow them.",
  },
  allowed: {
    title: "Who can write to the bot",
    footer:
      "Only these people are heard. Allow someone from the waiting list above, or add their Telegram user id here.",
    fieldLabel: "Telegram user id",
  },
  setUp: {
    title: "Set up a bot",
    create: {
      title: "1. Create the bot",
      description:
        "In Telegram, open @BotFather and send /newbot. Pick a name and a username; it replies with the bot token.",
    },
    token: {
      title: "2. Paste the token and turn it on",
      description: "Save the token above, then switch on Use Telegram.",
    },
    message: {
      title: "3. Message the bot",
      description:
        "Open your bot, press Start and say hello. You then show up under Waiting for approval here.",
    },
    allow: {
      title: "4. Allow yourself",
      description: "Press Allow next to your name. Then send @ to see your assistants.",
    },
  },
} as const;

type Copy = string | { readonly [key: string]: Copy };

const flatten = (copy: Copy): string[] =>
  typeof copy === "string" ? [copy] : Object.values(copy).flatMap(flatten);

export const TELEGRAM_PAGE_LABELS: readonly string[] = [
  ...flatten(TELEGRAM_COPY),
  ...CHANNEL_SHARED_LABELS,
];
