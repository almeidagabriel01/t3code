import { markdownMathRanges } from "./markdownMath.ts";

export type ComposerInlineToken =
  | {
      readonly type: "mention";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: "skill";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      /** A group member, `@handle`; value is the handle. */
      readonly type: "member";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      /** A group project, `#slug`; value is the slug. */
      readonly type: "project";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    };

export interface CollectComposerInlineTokensOptions {
  readonly preserveTrailingFrom?: ReadonlyArray<ComposerInlineToken>;
  /** Group members' handles: an `@handle` naming one is a member, not a file. */
  readonly memberHandles?: ReadonlyArray<string>;
  /** Group projects' `#slug`s (see `assistantGroupProjectSlug`). */
  readonly projectSlugs?: ReadonlyArray<string>;
}

const SKILL_MENTION_SOURCE =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)/u
    .source;
const SKILL_TOKEN_REGEX = new RegExp(`${SKILL_MENTION_SOURCE}(?=\\s)`, "gu");
export const SKILL_MENTION_PATTERN = new RegExp(`${SKILL_MENTION_SOURCE}(?=\\s|$)`, "gu");
const MENTION_TOKEN_REGEX = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;
const PROJECT_TOKEN_REGEX = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_./-]*)(?=\s)/gu;
// Bound unmatched-bracket rescans to avoid quadratic work; only basenames survive, and common filesystems cap them at 255.
const MAX_FILE_LINK_LABEL_LENGTH = 512;
const FILE_LINK_TOKEN_REGEX = new RegExp(
  `(^|\\s)\\[((?:\\\\.|[^\\]\\\\]){0,${MAX_FILE_LINK_LABEL_LENGTH}})\\]\\(([^)\\s]+)\\)(?=\\s)`,
  "g",
);
const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const SCOPED_PACKAGE_REFERENCE_REGEX =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[^\s@"]+)*$/;
const DECORATOR_CALL_REFERENCE_REGEX = /^[\p{ID_Start}_$][\p{ID_Continue}.$\u200c\u200d]*\(/u;

function collectMentionTokens(
  text: string,
  memberHandles: ReadonlySet<string> = new Set(),
): ComposerInlineToken[] {
  const matches: ComposerInlineToken[] = [];

  for (const match of text.matchAll(FILE_LINK_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const label = (match[2] ?? "").replace(/\\(.)/g, "$1");
    const encodedPath = match[3] ?? "";
    let path = encodedPath;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {}
    const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const basename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
    const hasExternalScheme = URI_SCHEME_REGEX.test(path) && !WINDOWS_DRIVE_PATH_REGEX.test(path);
    if (!path || hasExternalScheme || label !== basename) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "mention",
      value: path,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const quotedPath = match[2];
    const path = quotedPath !== undefined ? quotedPath.replace(/\\(.)/g, "$1") : (match[3] ?? "");
    if (
      !path ||
      (quotedPath === undefined &&
        (SCOPED_PACKAGE_REFERENCE_REGEX.test(path) || DECORATOR_CALL_REFERENCE_REGEX.test(path)))
    ) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    const member = quotedPath === undefined && memberHandles.has(path.toLowerCase());
    matches.push({
      type: member ? "member" : "mention",
      value: member ? path.toLowerCase() : path,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  return matches;
}

/**
 * Formulas in composer text, ignoring `$` and `\[` inside file links such as `posts.$postId.tsx`.
 * Links are masked with letters, not spaces, so a leading link cannot become an indented code
 * block. Bare `@path` mentions stay unmasked so `@README.md$` can still close a formula.
 */
export function composerMathRanges(
  text: string,
  mentions: ReadonlyArray<ComposerInlineToken> = collectMentionTokens(text),
) {
  let masked = text;
  for (const mention of mentions) {
    if (mention.type !== "mention" || !mention.source.startsWith("[")) continue;
    masked =
      masked.slice(0, mention.start) +
      "x".repeat(mention.end - mention.start) +
      masked.slice(mention.end);
  }
  return markdownMathRanges(masked).map(({ start, end }) => ({
    start,
    end,
    source: text.slice(start, end),
  }));
}

export function collectComposerInlineTokens(
  text: string,
  options: CollectComposerInlineTokensOptions = {},
): ReadonlyArray<ComposerInlineToken> {
  const handles = new Set(options.memberHandles?.map((handle) => handle.toLowerCase()));
  const matches = collectMentionTokens(text, handles);
  const slugs = new Set(options.projectSlugs);
  if (slugs.size > 0) {
    for (const match of text.matchAll(PROJECT_TOKEN_REGEX)) {
      const prefix = match[1] ?? "";
      const slug = (match[2] ?? "").toLowerCase();
      if (!slugs.has(slug)) continue;
      const start = (match.index ?? 0) + prefix.length;
      const end = start + match[0].length - prefix.length;
      matches.push({ type: "project", value: slug, source: text.slice(start, end), start, end });
    }
  }

  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const value = match[2] ?? "";
    if (!value) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "skill",
      value,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const token of options.preserveTrailingFrom ?? []) {
    if (
      token.end === text.length &&
      text.slice(token.start, token.end) === token.source &&
      !matches.some(
        (match) =>
          match.type === token.type && match.start === token.start && match.end === token.end,
      )
    ) {
      matches.push(token);
    }
  }

  // TeX can contain literal skill and file tokens, especially inside \text{}.
  // They remain formula source rather than becoming composer context chips.
  // Confirmed trailing file links are masked too, so a kept chip is not read as TeX.
  const math = matches.length > 0 ? composerMathRanges(text, matches) : [];
  return matches
    .filter(
      (match) => !math.some((formula) => match.start < formula.end && match.end > formula.start),
    )
    .sort((left, right) => left.start - right.start);
}
