import { parseDocument } from "yaml";

/**
 * Tolerant frontmatter reader. It never rejects: unknown keys are kept, YAML that does not
 * parse falls back to a line scan, and a file without frontmatter is all body. Nested maps are
 * flattened one level as `parent.child`; lists and deeper structures are ignored.
 */
export type Frontmatter = {
  readonly present: boolean;
  readonly fields: ReadonlyMap<string, string>;
  readonly body: string;
};

const YAML_MAX_CHARS = 16 * 1024;
const BLOCK = /^[ \t\n]*---[ \t]*\n(?:([\s\S]*?)\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/u;

const scalar = (value: unknown) =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  typeof value === "bigint"
    ? String(value).trim()
    : value instanceof Date
      ? value.toISOString()
      : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const fromYaml = (source: string) => {
  const doc = parseDocument(source, { version: "1.2", uniqueKeys: false });
  if (doc.errors.length) return undefined;
  let js: unknown;
  try {
    js = doc.toJS({ maxAliasCount: 10 });
  } catch {
    return undefined;
  }
  if (!isRecord(js)) return undefined;
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(js)) {
    const flat = scalar(value);
    if (flat !== undefined) fields.set(key, flat);
    else if (isRecord(value))
      for (const [child, nested] of Object.entries(value)) {
        const flatChild = scalar(nested);
        if (flatChild !== undefined) fields.set(`${key}.${child}`, flatChild);
      }
  }
  return fields;
};

const unquote = (value: string) => {
  const v = value.trim();
  return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]
    ? v.slice(1, -1)
    : v.replace(/\s+#.*$/u, "");
};
const fromLines = (source: string) => {
  const fields = new Map<string, string>();
  let parent: string | undefined;
  for (const line of source.split("\n")) {
    const top = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/u.exec(line);
    if (top) {
      const value = unquote(top[2] ?? "");
      parent = value === "" ? top[1] : undefined;
      if (value !== "") fields.set(top[1]!, value);
      continue;
    }
    const nested = parent && /^[ \t]+([A-Za-z0-9_.-]+):[ \t]+(.+)$/u.exec(line);
    if (nested) fields.set(`${parent}.${nested[1]}`, unquote(nested[2]!));
  }
  return fields;
};

export const readFrontmatter = (raw: string): Frontmatter => {
  const text = raw.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
  const match = BLOCK.exec(text);
  if (!match) return { present: false, fields: new Map(), body: text };
  const source = match[1] ?? "";
  const fields =
    (source.length <= YAML_MAX_CHARS ? fromYaml(source) : undefined) ?? fromLines(source);
  return { present: true, fields, body: text.slice(match[0].length) };
};

/** First non-empty value among the keys, for per-format mappers with fallbacks. */
export const firstField = (frontmatter: Frontmatter, ...keys: readonly string[]) => {
  for (const key of keys) {
    const value = frontmatter.fields.get(key);
    if (value) return value;
  }
  return undefined;
};
