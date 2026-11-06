import type { ChannelChoice } from "@t3tools/contracts";

import { channelStrings, type ResolvedChannelLanguage } from "../channelStrings.ts";

/** Characters per message; longer replies are split at paragraph boundaries. */
export const IMESSAGE_CHUNK_LIMIT = 1500;
/** A reply longer than this many messages ends with a note instead of flooding the chat. */
export const IMESSAGE_MAX_MESSAGES = 6;

/**
 * iMessage has no rich text: emphasis markers and headings go, links keep their address, code
 * keeps its lines without the fences.
 */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm, "$1")
    .replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ")
    .replace(/(\*\*\*|\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Splits at a newline or space when a single paragraph is longer than the limit. */
function splitLong(paragraph: string, limit: number): Array<string> {
  const out: Array<string> = [];
  let rest = paragraph;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    // Never cut between the halves of a surrogate pair.
    if (/[\uD800-\uDBFF]/.test(rest.charAt(cut - 1))) cut -= 1;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "") out.push(rest);
  return out;
}

/** Packs whole paragraphs into messages of at most `limit` characters. */
export function chunkParagraphs(text: string, limit = IMESSAGE_CHUNK_LIMIT): Array<string> {
  const chunks: Array<string> = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/).flatMap((part) => splitLong(part, limit))) {
    const joined = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    if (joined.length <= limit) {
      current = joined;
      continue;
    }
    if (current !== "") chunks.push(current);
    current = paragraph;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

const numberedChoices = (choices: ReadonlyArray<ChannelChoice>, hint: string) =>
  [...choices.map((choice, index) => `${index + 1}. ${choice.label}`), hint].join("\n");

export interface ChannelTextLimits {
  readonly chunkLimit: number;
  readonly maxMessages: number;
}

/**
 * The messages one reply is sent as. Each starts with the speaker's name so replies read apart
 * from your own messages in a chat with yourself; choices end the last message as a numbered list.
 */
export function formatChannelMessages(
  input: {
    readonly senderName: string;
    readonly text: string;
    readonly choices?: ReadonlyArray<ChannelChoice> | undefined;
    /** The language of the phrases added here; English when absent. */
    readonly language?: ResolvedChannelLanguage | undefined;
  },
  { chunkLimit, maxMessages }: ChannelTextLimits,
): Array<string> {
  const strings = channelStrings(input.language ?? "en");
  const choices =
    input.choices !== undefined && input.choices.length > 0 ? input.choices : undefined;
  const room = maxMessages - (choices === undefined ? 0 : 1);
  const body = chunkParagraphs(toPlainText(input.text), chunkLimit);
  const kept = body.length <= room ? body : [...body.slice(0, room - 1), strings.truncatedNote];
  if (choices !== undefined) {
    const block = numberedChoices(choices, strings.replyWithNumber);
    const last = kept.at(-1);
    if (last !== undefined && last.length + block.length + 2 <= chunkLimit) {
      kept[kept.length - 1] = `${last}\n\n${block}`;
    } else kept.push(block);
  }
  return kept.map((chunk) => `${input.senderName}: ${chunk}`);
}

export const formatImessageMessages = (input: Parameters<typeof formatChannelMessages>[0]) =>
  formatChannelMessages(input, {
    chunkLimit: IMESSAGE_CHUNK_LIMIT,
    maxMessages: IMESSAGE_MAX_MESSAGES,
  });
