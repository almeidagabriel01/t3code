import { isQuietReply } from "@t3tools/shared/assistantTaskEvents";

import type { TurnOrigin } from "../mcp/turnOrigin.ts";

const BRIEF_MAX_LINES = 8;
const BRIEF_MAX_CHARS = 600;

/** The user asked for these turns, so their whole answer goes out; any other turn is an event. */
const asksForFullAnswer = (origin: TurnOrigin) => origin === "user" || origin === "routine";

/**
 * The head of a reply for a chat app: whole lines up to a size a phone shows at a glance,
 * stopping before a table or code block. The full text stays in the T3 thread.
 */
export function briefReply(text: string): string {
  const lines = text.trim().split("\n");
  const kept: Array<string> = [];
  let size = 0;
  for (const line of lines) {
    if (/^\s*(?:`{3}|~{3}|\|)/.test(line)) break;
    if (kept.length === BRIEF_MAX_LINES || size + line.length > BRIEF_MAX_CHARS) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (kept.length === lines.length) return text.trim();
  const head = kept.join("\n").trimEnd();
  if (head !== "") return `${head}\n…`;
  // One line longer than the whole budget: cut it at a word.
  const first = lines[0]!.slice(0, BRIEF_MAX_CHARS);
  return `${first.slice(0, Math.max(first.lastIndexOf(" "), 1)).trimEnd()}…`;
}

/**
 * What an assistant run tells the user outside T3 (chat apps, group chat): undefined when it
 * has nothing to say, including an event turn the assistant ended quiet.
 */
export function assistantRunReply(
  text: string | undefined,
  origin: TurnOrigin,
): string | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  if (asksForFullAnswer(origin)) return text;
  return isQuietReply(text) ? undefined : briefReply(text);
}
