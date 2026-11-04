import type { NoteDocument, NotesMoveInput } from "@t3tools/contracts";

/** A note's title is the first heading, else its first non-empty line, as the server reads it. */
const HEADING = /^(#{1,6})([ \t]+)(.+?)[ \t]*#*[ \t]*$/u;
const LIST_MARKERS = /^(?:(?:[-*+>]|\d+\.)\s+|\[[ xX]\]\s*)+/u;

/** The body with its title line rewritten to `title`, keeping that line's heading level or list marker. */
export function replaceNoteTitle(body: string, title: string): string {
  const next = title.replace(/\s+/gu, " ").trim();
  const lines = body.split("\n");
  const stripCr = (line: string) => line.replace(/\r$/u, "");
  let index = lines.findIndex((line) => HEADING.test(stripCr(line)));
  if (index < 0) index = lines.findIndex((line) => stripCr(line).trim().length > 0);
  if (index < 0) return `# ${next}${body.length > 0 ? `\n${body}` : ""}`;
  const line = stripCr(lines[index]!);
  const cr = lines[index]!.endsWith("\r") ? "\r" : "";
  const heading = HEADING.exec(line);
  const prefix = heading
    ? `${heading[1]}${heading[2]}`
    : /^\s*/u.exec(line)![0] + (LIST_MARKERS.exec(line.trim())?.[0] ?? "");
  lines[index] = `${prefix}${next}${cr}`;
  return lines.join("\n");
}

const DEFAULT_NAME = /^Untitled(?: \d+)?\.md$/u;
const DEFAULT_TITLE = /^Untitled(?: \d+)?$/u;
const FILE_STEM_MAX = 80;

function fileStem(title: string): string {
  const cut = title
    .replace(/[\u0000-\u001f\u007f\\/:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .slice(0, FILE_STEM_MAX);
  return cut
    .replace(/[\uD800-\uDBFF]$/u, "")
    .replace(/[\s.]+$/u, "")
    .normalize("NFC");
}

/**
 * The file a note should move to when its title changes, or null when it keeps its name: the file
 * was named by hand (neither Untitled N.md nor the old title, with or without a " N" suffix), or the
 * new title is empty, a default, or has no usable characters. attempt 1, 2, ... appends " 2", " 3".
 */
export function titleRenameTarget(
  path: string,
  previousTitle: string,
  nextTitle: string,
  attempt = 0,
): string | null {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const stem = fileStem(nextTitle);
  if (!stem || DEFAULT_TITLE.test(nextTitle.trim())) return null;
  const old = fileStem(previousTitle);
  const named =
    DEFAULT_NAME.test(name) ||
    (old.length > 0 &&
      (name === `${old}.md` || new RegExp(`^${escapeRegExp(old)} \\d+\\.md$`, "u").test(name)));
  if (!named) return null;
  const to = `${path.slice(0, slash + 1)}${stem}${attempt > 0 ? ` ${attempt + 1}` : ""}.md`;
  return to === path ? null : to;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export type NoteMoveReply = { ok: true; value: NoteDocument } | { ok: false; error: unknown };

/**
 * Moves a note's file to follow its new title when it was named after the old one, stepping past
 * a name taken since the list loaded. Null when the file keeps its name or no free name was found.
 */
export async function moveToTitle(
  move: (input: NotesMoveInput) => Promise<NoteMoveReply>,
  note: { path: string; revision: string },
  previousTitle: string,
  title: string,
): Promise<NoteDocument | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const to = titleRenameTarget(note.path, previousTitle, title, attempt);
    if (to === null) return null;
    const result = await move({ from: note.path, to, baseRevision: note.revision });
    if (result.ok) return result.value;
    const error = result.error;
    if (
      typeof error !== "object" ||
      error === null ||
      !("reason" in error) ||
      error.reason !== "exists"
    )
      return null;
  }
  return null;
}
