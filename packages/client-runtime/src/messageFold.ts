import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";

const MAX_FOLDED_LINES = 8;
const MAX_FOLDED_LENGTH = 600;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

/** The text a reader sees: link labels and quote chips, not their encoded targets. */
function visibleText(text: string): string {
  const linkLabels = (segment: string) => segment.replace(MARKDOWN_LINK, "$1");
  let visible = "";
  let cursor = 0;
  for (const match of collectAssistantCitations(text)) {
    visible += linkLabels(text.slice(cursor, match.start)) + assistantCitationLabel(match.citation);
    cursor = match.end;
  }
  return visible + linkLabels(text.slice(cursor));
}

/** Whether a message is long enough to show folded, with a way to read all of it. */
export function isLongMessage(text: string): boolean {
  const visible = visibleText(text);
  if (visible.trim().length === 0) return false;
  return visible.length > MAX_FOLDED_LENGTH || visible.split("\n").length > MAX_FOLDED_LINES;
}
