import { isQuietReply, withoutQuietToken } from "@t3tools/shared/assistantTaskEvents";

import type { TurnOrigin } from "../mcp/turnOrigin.ts";

const BRIEF_MAX_LINES = 8;
const BRIEF_MAX_CHARS = 600;

/** The user asked for these turns, so their whole answer goes out; any other turn is an event. */
const asksForFullAnswer = (origin: TurnOrigin) => origin === "user" || origin === "routine";

/**
 * The head of a reply for a chat app: its prose lines up to a size a phone shows at a glance,
 * leaving out tables and code blocks. The full text stays in the T3 thread.
 */
export function briefReply(text: string): string {
  const kept: Array<string> = [];
  let size = 0;
  let inFence = false;
  let omitted = false;
  for (const line of text.trim().split("\n")) {
    const fence = /^\s*(?:`{3}|~{3})/.test(line);
    if (fence || inFence || /^\s*\|/.test(line)) {
      if (fence) inFence = !inFence;
      omitted = true;
      continue;
    }
    if (kept.length === BRIEF_MAX_LINES || size + line.length > BRIEF_MAX_CHARS) {
      omitted = true;
      if (kept.some((keptLine) => keptLine.trim() !== "")) break;
      // One line longer than the whole budget: cut it at a word.
      const head = line.slice(0, BRIEF_MAX_CHARS);
      return `${head.slice(0, Math.max(head.lastIndexOf(" "), 1)).trimEnd()}…`;
    }
    kept.push(line);
    size += line.length + 1;
  }
  const head = kept.join("\n").trim();
  if (!omitted) return head;
  return head === "" ? "…" : `${head}\n…`;
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
  return isQuietReply(text) ? undefined : briefReply(withoutQuietToken(text));
}
