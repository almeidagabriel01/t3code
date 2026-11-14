import { isQuietReply, withoutQuietToken } from "@t3tools/shared/assistantTaskEvents";
import { parseMarkdown, type RootContent } from "@t3tools/shared/markdownAst";

import type { TurnOrigin } from "../mcp/turnOrigin.ts";

const BRIEF_MAX_LINES = 8;
const BRIEF_MAX_CHARS = 600;

/** Blocks a phone cannot show at a glance; the T3 thread keeps them. */
const LEFT_OUT = new Set(["table", "code", "html", "definition", "thematicBreak"]);

/** The user asked for these turns, so their whole answer goes out; any other turn is an event. */
const asksForFullAnswer = (origin: TurnOrigin) => origin === "user" || origin === "routine";

const plainText = (node: RootContent): string => {
  if ("value" in node) return node.value;
  if (node.type === "break") return "\n";
  return "children" in node ? node.children.map(plainText).join("") : "";
};

/**
 * The head of a reply for a chat app: whole Markdown blocks (list items one by one) up to what a
 * phone shows at a glance, leaving out tables and code blocks. A first block too big to fit goes
 * as plain text cut at a word, so no bold or link is left open. The full text stays in T3.
 */
export function briefReply(text: string): string {
  const source = text.trim();
  const kept: Array<{ readonly start: number; readonly end: number; readonly adjacent: boolean }> =
    [];
  let omitted = false;
  let adjacent = false;

  const render = () =>
    kept
      .map((piece, index) => {
        const gap =
          index === 0
            ? ""
            : piece.adjacent
              ? source.slice(kept[index - 1]!.end, piece.start)
              : "\n\n";
        return gap + source.slice(piece.start, piece.end);
      })
      .join("");
  const fits = (rendered: string) =>
    rendered.split("\n").length <= BRIEF_MAX_LINES && rendered.length <= BRIEF_MAX_CHARS;

  let cut: string | undefined;
  const cutPlain = (plain: string) => {
    const lines: Array<string> = [];
    let size = 0;
    for (const line of plain.trim().split("\n")) {
      if (lines.length === BRIEF_MAX_LINES || size + line.length > BRIEF_MAX_CHARS) break;
      lines.push(line);
      size += line.length + 1;
    }
    if (lines.length > 0) {
      cut = lines.join("\n");
      return;
    }
    const head = plain.trim().slice(0, BRIEF_MAX_CHARS);
    cut = `${head.slice(0, Math.max(head.lastIndexOf(" "), 1)).trimEnd()}…`;
  };

  /** Keeps nodes while they fit; false once one does not, which ends the brief. */
  const keep = (nodes: ReadonlyArray<RootContent>): boolean => {
    for (const node of nodes) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (LEFT_OUT.has(node.type) || start === undefined || end === undefined) {
        omitted = true;
        adjacent = false;
        continue;
      }
      kept.push({ start, end, adjacent });
      if (fits(render())) {
        adjacent = true;
        continue;
      }
      kept.pop();
      if (node.type === "list") {
        if (!keep(node.children)) return false;
        continue;
      }
      omitted = true;
      if (kept.length === 0) cutPlain(plainText(node));
      return false;
    }
    return true;
  };

  keep(parseMarkdown(source).children);
  if (cut !== undefined) return cut.endsWith("…") ? cut : `${cut}\n…`;
  if (!omitted) return source;
  const head = render().trimEnd();
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
