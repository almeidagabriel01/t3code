/** The user guides (docs/user) as agents read them: pages, their sections, and a word search. */

export interface UserGuideSection {
  readonly heading: string;
  readonly depth: 2 | 3;
  /** GitHub-style slug, unique within the page. */
  readonly anchor: string;
  /** From the heading to the next heading of any depth. */
  readonly text: string;
}

export interface UserGuidePage {
  readonly page: string;
  readonly title: string;
  readonly markdown: string;
  /** Text before the first section heading, the title line excluded. */
  readonly lead: string;
  readonly sections: ReadonlyArray<UserGuideSection>;
}

/** The heading text a reader sees: links, inline code and emphasis reduced to their words. */
const headingText = (raw: string) =>
  raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*~]/g, "")
    .trim();

const slugOf = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** Parses one guide. Lines inside fenced code are never read as headings. */
export function parseUserGuide(page: string, markdown: string): UserGuidePage {
  const seen = new Map<string, number>();
  let title: string | undefined;
  let fence: string | undefined;
  const lead: Array<string> = [];
  const sections: Array<{ heading: string; depth: 2 | 3; anchor: string; lines: Array<string> }> =
    [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker !== undefined)
      fence = fence === undefined ? marker : fence === marker ? undefined : fence;
    const match =
      fence === undefined && marker === undefined ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (match !== null) {
      const depth = match[1]!.length;
      const text = headingText(match[2]!);
      if (depth === 1 && title === undefined) {
        title = text;
        continue;
      }
      if (depth === 2 || depth === 3) {
        const base = slugOf(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        sections.push({
          heading: text,
          depth,
          anchor: count === 0 ? base : `${base}-${count}`,
          lines: [],
        });
        continue;
      }
    }
    (sections.at(-1)?.lines ?? lead).push(line);
  }
  return {
    page,
    title: title ?? page,
    markdown,
    lead: lead.join("\n").trim(),
    sections: sections.map(({ lines, ...section }) => ({
      ...section,
      text: lines.join("\n").trim(),
    })),
  };
}

export interface UserGuideMatch {
  readonly page: string;
  readonly title: string;
  /** null for the text before the page's first section. */
  readonly heading: string | null;
  readonly anchor: string | null;
  readonly snippet: string;
}

const STOP_WORDS = new Set(
  "a an and are can do does for how i in is it my of on or the to what when where why with".split(
    " ",
  ),
);

const queryWords = (query: string) => [
  ...new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []).filter(
      (word) => !STOP_WORDS.has(word),
    ),
  ),
];

const SNIPPET_LENGTH = 240;

function snippetAround(text: string, words: ReadonlyArray<string>) {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const found = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0);
  const start = found.length === 0 ? 0 : Math.max(0, Math.min(...found) - 60);
  const end = start + SNIPPET_LENGTH;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Sections holding the query's words, best first. A word in the heading counts most, one in the
 * page title next, one only in the body least; more distinct words win, shorter sections break ties.
 */
export function searchUserGuides(pages: ReadonlyArray<UserGuidePage>, query: string) {
  const words = queryWords(query);
  const scored: Array<{ readonly match: UserGuideMatch; readonly score: number }> = [];
  if (words.length === 0) return { words, matches: [] as ReadonlyArray<UserGuideMatch> };
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const units = [{ heading: null, anchor: null, text: page.lead }, ...page.sections];
    for (const unit of units) {
      const heading = unit.heading?.toLowerCase() ?? "";
      const body = unit.text.toLowerCase();
      const inHeading = words.filter((word) => heading.includes(word));
      const inTitle = words.filter((word) => title.includes(word));
      const matched = words.filter(
        (word) => inHeading.includes(word) || inTitle.includes(word) || body.includes(word),
      );
      if (matched.length === 0) continue;
      scored.push({
        score:
          matched.length * 60 +
          inHeading.length * 40 +
          inTitle.length * 20 -
          Math.min(9, unit.text.length / 2000),
        match: {
          page: page.page,
          title: page.title,
          heading: unit.heading,
          anchor: unit.anchor,
          snippet: snippetAround(unit.text === "" ? page.title : unit.text, matched),
        },
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return { words, matches: scored.map((entry) => entry.match) };
}
