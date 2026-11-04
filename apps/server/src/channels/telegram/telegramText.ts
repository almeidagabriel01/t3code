import { formatChannelMessages } from "../imessage/imessageText.ts";

/** Telegram allows 4096 characters; the rest is room for the speaker's name that starts each message. */
export const TELEGRAM_CHUNK_LIMIT = 3900;
const TELEGRAM_MAX_MESSAGES = 6;

/**
 * Replies are sent as plain text with no parse mode, so nothing in an assistant's answer can be
 * read as markup or break the request: formatting is dropped the same way as for iMessage.
 */
export const formatTelegramMessages = (input: Parameters<typeof formatChannelMessages>[0]) =>
  formatChannelMessages(input, {
    chunkLimit: TELEGRAM_CHUNK_LIMIT,
    maxMessages: TELEGRAM_MAX_MESSAGES,
  });
