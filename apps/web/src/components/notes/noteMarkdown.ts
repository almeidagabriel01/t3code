import { attachmentImageMarkdown } from "@t3tools/shared/attachmentImageRefs";
import type { JSONContent } from "@tiptap/core";
import type { Blockquote, List, Paragraph, RootContent, Table } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  parseInlineMarkdown,
  RICH_TEXT_DELIMITERS,
  type RichTextMark,
} from "../../composer-rich-text";

// Source is retained per block, so editing a heading never rewrites an adjacent table or fence.
function fingerprintValue(node: JSONContent): unknown[] {
  return [
    node.type,
    node.text,
    ...["level", "checked", "start", "language", "attachmentId", "name", "kind"].map(
      (key) => node.attrs?.[key] ?? null,
    ),
    node.marks?.map((mark) => mark.type + (mark.attrs?.href ?? "")).sort() ?? [],
    node.content?.map(fingerprintValue) ?? [],
  ];
}

function fingerprint(node: JSONContent): string {
  return JSON.stringify(fingerprintValue(node));
}

function text(value: string): JSONContent[] {
  return value ? [{ type: "text", text: value }] : [];
}

const LINK = /\[([^\][\\<>\n]+)\]\(([^\s()<>\\]+)\)/g;

// Escapes, HTML, images and extension syntax stay literal until the note codec supports them.
function segment(value: string, extra: JSONContent["marks"] = []): JSONContent[] | null {
  if (/[\\[\]<>]|!\[|\$/.test(value) || /`{2,}/.test(value)) return null;
  if ((value.split("`").length - 1) % 2 !== 0) return null;
  return parseInlineMarkdown(value)
    .filter((span) => span.text)
    .map((span) => ({
      type: "text",
      text: span.text,
      marks: [...span.marks.map((type) => ({ type })), ...extra],
    }));
}

function line(value: string): JSONContent[] | null {
  const result: JSONContent[] = [];
  let last = 0;
  for (const match of value.matchAll(LINK)) {
    const before = value.slice(last, match.index);
    if (before.endsWith("!")) return null;
    const plain = segment(before);
    const linked = segment(match[1]!, [{ type: "link", attrs: { href: match[2] } }]);
    if (!plain || !linked) return null;
    result.push(...plain, ...linked);
    last = match.index + match[0].length;
  }
  const tail = segment(value.slice(last));
  return tail && [...result, ...tail];
}

function inline(value: string): JSONContent[] | null {
  if (/ {2}\n/.test(value)) return null;
  const parts: JSONContent[] = [];
  for (const [index, text] of value.split("\n").entries()) {
    const content = line(text);
    if (!content) return null;
    parts.push(...(index ? [{ type: "hardBreak" }] : []), ...content);
  }
  return parts;
}

// Reuse the renderer's CommonMark/GFM grammar; the AST only owns kinds and source boundaries.
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

// The line form the kanban description editor also reads; anything else around an image stays raw.
const ATTACHMENT_IMAGE = /^!\[([^\]\n]*)\]\(t3-attachment:([a-z0-9][a-z0-9_-]*)\)$/i;

function paragraph(node: Paragraph, markdown: string, quoted = false): JSONContent | null {
  // GFM may leave the paragraph start before a removed checkbox when emphasis comes first.
  const start = node.children[0]?.position?.start.offset ?? node.position!.start.offset!;
  const lines = markdown.slice(start, node.position!.end.offset!).split("\n");
  // Only canonical quote prefixes can be serialized without changing their source.
  if (quoted) {
    for (let index = 1; index < lines.length; index++) {
      if (!lines[index]!.startsWith("> ")) return null;
      lines[index] = lines[index]!.slice(2);
    }
  }
  const source = lines.join("\n");
  const content = source.includes("|") ? null : inline(source);
  return content ? { type: "paragraph", content } : null;
}

// Expose the existing subset: one single-line paragraph followed by nested lists per item.
// Parser children, rather than indentation guesses, decide what belongs to each item.
function list(node: List, markdown: string): JSONContent | null {
  const task = node.children[0]?.checked != null;
  const type = task ? "taskList" : node.ordered ? "orderedList" : "bulletList";
  const items: JSONContent[] = [];
  for (const item of node.children) {
    if ((item.checked != null) !== task) return null;
    const first = item.children[0];
    if (first?.type !== "paragraph" || first.position!.start.line !== first.position!.end.line)
      return null;
    const start = first.children[0]?.position?.start.offset;
    if (task && start !== undefined && markdown[start] === " ") return null;
    const firstParagraph = paragraph(first, markdown);
    if (!firstParagraph) return null;
    const content = [firstParagraph];
    for (const child of item.children.slice(1)) {
      if (child.type !== "list") return null;
      const nested = list(child, markdown);
      if (!nested) return null;
      content.push(nested);
    }
    items.push({
      type: task ? "taskItem" : "listItem",
      ...(task ? { attrs: { checked: item.checked } } : {}),
      content,
    });
  }
  return {
    type,
    ...(type === "orderedList" ? { attrs: { start: node.start } } : {}),
    content: items,
  };
}

const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/;

// GitHub alert: a quote whose first line is the marker; the rest are paragraphs.
function callout(node: Blockquote, markdown: string): JSONContent | null {
  const first = node.children[0];
  if (first?.type !== "paragraph") return null;
  const lines = markdown
    .slice(first.position!.start.offset!, first.position!.end.offset!)
    .split("\n");
  const kind = CALLOUT.exec(lines[0]!)?.[1];
  if (!kind) return null;
  const content: JSONContent[] = [];
  const rest = lines.slice(1);
  if (rest.some((value) => !value.startsWith("> "))) return null;
  if (rest.length) {
    const body = inline(rest.map((value) => value.slice(2)).join("\n"));
    if (!body) return null;
    content.push({ type: "paragraph", content: body });
  }
  for (const child of node.children.slice(1)) {
    const next = child.type === "paragraph" ? paragraph(child, markdown, true) : null;
    if (!next) return null;
    content.push(next);
  }
  return {
    type: "callout",
    attrs: { kind },
    content: content.length ? content : [{ type: "paragraph" }],
  };
}

function table(node: Table, markdown: string): JSONContent | null {
  if (node.align?.some((value) => value != null)) return null;
  const rows: JSONContent[] = [];
  for (const [rowIndex, row] of node.children.entries()) {
    const cells: JSONContent[] = [];
    for (const cell of row.children) {
      const source = cell.position
        ? markdown.slice(cell.position.start.offset!, cell.position.end.offset!)
        : "";
      const content = inline(
        source
          .replace(/^\s*\|/, "")
          .replace(/(?<!\\)\|\s*$/, "")
          .trim()
          .replace(/\\\|/g, "|"),
      );
      if (!content) return null;
      cells.push({
        type: rowIndex ? "tableCell" : "tableHeader",
        content: [{ type: "paragraph", content }],
      });
    }
    rows.push({ type: "tableRow", content: cells });
  }
  return { type: "table", content: rows };
}

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  position?: unknown;
};
const PHRASING = new Set(["text", "emphasis", "strong", "delete", "inlineCode", "link", "break"]);

// Inline styles compare as flat (text, style set) runs: the editor has no nesting order.
function runs(nodes: readonly MdastNode[], marks: string[] = [], out: [string, string][] = []) {
  for (const node of nodes) {
    if (node.children) runs(node.children, [...marks, node.type + (node.url ?? "")], out);
    else {
      const own = node.type === "inlineCode" ? [...marks, "code"] : marks;
      const { position: _position, ...rest } = node;
      const value = node.type === "break" ? "\n" : (node.value ?? JSON.stringify(rest));
      const key = own.toSorted().join();
      if (out.at(-1)?.[1] === key) out[out.length - 1]![0] += value;
      else out.push([value, key]);
    }
  }
  return out;
}

function shape(node: MdastNode): unknown {
  const { position: _position, children, ...rest } = node;
  if (!children) return rest;
  if (children.some((child) => PHRASING.has(child.type))) return { ...rest, runs: runs(children) };
  return { ...rest, children: children.map(shape) };
}

// Spelling (bullet marker, emphasis marker, `[X]`, closing #s) is not meaning: a candidate is kept
// when its canonical form parses to the same tree as the source. Unchanged blocks still write
// back their original bytes; only edited blocks take the canonical spelling.
function sameMeaning(canonical: string, source: string): boolean {
  if (canonical === source) return true;
  const tree = (value: string) =>
    JSON.stringify((parser.parse(value).children as MdastNode[]).map(shape));
  return tree(canonical) === tree(source);
}

function raw(source: string): JSONContent {
  return { type: "noteRawMarkdown", content: text(source) };
}

function block(source: string, node: RootContent, markdown: string): JSONContent {
  const lines = source.split("\n");
  if (node.type === "code") {
    const fence = /^(`{3,}|~{3,})([^\s`~]*)\s*$/.exec(lines[0]!);
    if (fence && lines.length > 1) {
      const close = lines.at(-1)!;
      if (new RegExp(`^${fence[1]![0]}{${fence[1]!.length},}\\s*$`).test(close)) {
        return {
          type: "codeBlock",
          attrs: { language: fence[2] },
          content: text(lines.slice(1, -1).join("\n")),
        };
      }
    }
  } else if (node.type === "heading") {
    const heading = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(source);
    const content = heading && inline(heading[2]!);
    if (heading && content)
      return { type: "heading", attrs: { level: heading[1]!.length }, content };
  } else if (node.type === "thematicBreak") {
    return { type: "horizontalRule" };
  } else if (node.type === "list") {
    return list(node, markdown) ?? raw(source);
  } else if (node.type === "blockquote") {
    const alert = callout(node, markdown);
    if (alert) return alert;
    const child = node.children[0];
    if (node.children.length === 1 && child?.type === "paragraph") {
      const content = paragraph(child, markdown, true);
      if (content) return { type: "blockquote", content: [content] };
    }
  } else if (node.type === "table") {
    return table(node, markdown) ?? raw(source);
  } else if (node.type === "paragraph") {
    const image = ATTACHMENT_IMAGE.exec(source);
    if (image)
      return { type: "attachmentImage", attrs: { name: image[1], attachmentId: image[2] } };
    return paragraph(node, markdown) ?? raw(source);
  }
  return raw(source);
}

// A bullet list next to a to-do list reparses as one mixed list; keep each run its own block.
function splitTaskRuns(node: RootContent): RootContent[] {
  if (node.type !== "list") return [node];
  const runs: List[] = [];
  for (const item of node.children) {
    const last = runs.at(-1);
    if (
      last &&
      ((last.children[0]!.checked != null) === (item.checked != null) ||
        // A misindented sibling is not a list the editor wrote; it stays literal.
        item.position!.start.column !== node.position!.start.column)
    ) {
      last.children.push(item);
      last.position = { start: last.position!.start, end: item.position!.end };
    } else {
      runs.push({ ...node, children: [item], position: item.position });
    }
  }
  return runs;
}

// Called once when an editor document loads. Edits serialize the editor tree without parsing.
export function noteMarkdownToDoc(markdown: string): JSONContent {
  // Keep CRLF documents literal; normalization would change unrelated lines on the next save.
  if (markdown.includes("\r"))
    return { type: "doc", content: [{ ...raw(markdown), attrs: { noteSuffix: "" } }] };
  const nodes = parser.parse(markdown).children.flatMap(splitTaskRuns);
  const content: JSONContent[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const start = node.position!.start.offset!;
    let end = node.position!.end.offset!;
    let overlapping = false;
    // Setext headings can overlap preceding definitions in the parser's source positions.
    while (index + 1 < nodes.length && nodes[index + 1]!.position!.start.offset! < end) {
      overlapping = true;
      end = Math.max(end, nodes[++index]!.position!.end.offset!);
    }
    const source = markdown.slice(start, end);
    const next = nodes[index + 1];
    const suffix = markdown.slice(end, next?.position!.start.offset);
    const candidate = overlapping ? raw(source) : block(source, node, markdown);
    // Check the entire tree once: a noncanonical child keeps its containing block literal.
    const parsed = sameMeaning(serializeBlock(candidate), source) ? candidate : raw(source);
    parsed.attrs = {
      ...parsed.attrs,
      notePrefix: content.length === 0 ? markdown.slice(0, start) : "",
      noteSource: source,
      noteFingerprint: fingerprint(parsed),
      noteSuffix: suffix,
      // The document's trailing text; it moves to whichever block ends up last.
      ...(next === undefined ? { noteTail: true } : {}),
    };
    content.push(parsed);
  }
  return {
    type: "doc",
    content: content.length
      ? content
      : [
          {
            ...(markdown ? raw(markdown) : { type: "paragraph" }),
            attrs: { noteSuffix: "", noteTail: true },
          },
        ],
  };
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function inlineText(node: JSONContent): string {
  if (node.type === "hardBreak") return "\n";
  const raw = node.text ?? "";
  if (!node.marks?.some((mark) => mark.type === "code"))
    return raw.replace(/([\\`*_[\]<>~])/g, "\\$1");
  // Code encloses only the text, regardless of the schema's mark order.
  const length = longestBacktickRun(raw) + 1;
  const fence = "`".repeat(length);
  const pad =
    raw.startsWith("`") ||
    raw.endsWith("`") ||
    (raw.startsWith(" ") && raw.endsWith(" ") && /[^ ]/.test(raw));
  return `${fence}${pad ? ` ${raw} ` : raw}${fence}`;
}

function inlineMarkdown(node: JSONContent): string {
  if (node.type === "hardBreak") return "\n";
  const children = node.text === undefined ? (node.content ?? []) : [node];
  let result = "";
  let index = 0;
  while (index < children.length) {
    const href = children[index]!.marks?.find((mark) => mark.type === "link")?.attrs?.href;
    if (typeof href === "string") {
      let end = index;
      while (
        end < children.length &&
        children[end]!.type !== "hardBreak" &&
        children[end]!.marks?.some((mark) => mark.type === "link" && mark.attrs?.href === href)
      )
        end++;
      const content = children.slice(index, end).map((child) => ({
        ...child,
        marks: (child.marks ?? []).filter((mark) => mark.type !== "link"),
      }));
      const target = href.replace(/[\s()]/g, (c) =>
        encodeURIComponent(c).replace(/[()]/g, (p) => (p === "(" ? "%28" : "%29")),
      );
      result += `[${inlineMarkdown({ content })}](${target})`;
      index = end;
      continue;
    }
    let sharedMark: RichTextMark | undefined;
    let end = index;
    // The longest shared emphasis stays outside shorter styles and code spans.
    for (const type of ["strike", "bold", "italic"] as const) {
      let next = index;
      while (
        next < children.length &&
        children[next]!.type !== "hardBreak" &&
        children[next]!.marks?.some((mark) => mark.type === type)
      )
        next++;
      if (next > end) {
        sharedMark = type;
        end = next;
      }
    }
    if (sharedMark) {
      const content = children.slice(index, end).map((child) => ({
        ...child,
        marks: (child.marks ?? []).filter((mark) => mark.type !== sharedMark),
      }));
      const marker = RICH_TEXT_DELIMITERS[sharedMark];
      result += marker + inlineMarkdown({ content }) + marker;
      index = end;
    } else {
      result += inlineText(children[index++]!);
    }
  }
  return result;
}

function isList(node: JSONContent): boolean {
  return ["bulletList", "orderedList", "taskList"].includes(node.type ?? "");
}

// Accumulate nested list output once; joining at each ancestor copies long leaves repeatedly.
function appendList(node: JSONContent, indent: string, parts: string[]): void {
  for (const [index, item] of (node.content ?? []).entries()) {
    if (index) parts.push("\n");
    const marker = node.type === "orderedList" ? `${Number(node.attrs?.start ?? 1) + index}.` : "-";
    const check = node.type === "taskList" ? `[${item.attrs?.checked ? "x" : " "}] ` : "";
    for (const [childIndex, child] of (item.content ?? []).entries()) {
      if (childIndex === 0) {
        parts.push(indent, marker, " ", check, inlineMarkdown(child));
      } else {
        parts.push("\n");
        const nestedIndent = `${indent}${" ".repeat(marker.length + 1)}`;
        if (isList(child)) appendList(child, nestedIndent, parts);
        else parts.push(serializeBlock(child, nestedIndent));
      }
    }
  }
}

function serializeBlock(node: JSONContent, indent = ""): string {
  const children = node.content ?? [];
  if (node.type === "noteRawMarkdown") return children.map((child) => child.text ?? "").join("");
  if (node.type === "heading")
    return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inlineMarkdown(node)}`;
  if (node.type === "horizontalRule") return "---";
  if (node.type === "attachmentImage")
    return attachmentImageMarkdown(
      String(node.attrs?.name ?? ""),
      String(node.attrs?.attachmentId),
    );
  if (node.type === "codeBlock") {
    const value = children.map((child) => child.text ?? "").join("");
    const fence = "`".repeat(Math.max(2, longestBacktickRun(value)) + 1);
    return `${fence}${node.attrs?.language ?? ""}\n${value}\n${fence}`;
  }
  if (node.type === "callout") {
    const body = children
      .filter((child) => child.content?.length)
      .map((child) => serializeBlock(child).replace(/^/gm, "> "));
    return [`> [!${String(node.attrs?.kind ?? "NOTE")}]`, body.join("\n> \n")]
      .filter(Boolean)
      .join("\n");
  }
  if (node.type === "table") {
    const rows = children.map(
      (row) =>
        `| ${(row.content ?? [])
          .map((cell) =>
            (cell.content ?? [])
              .map((child) => inlineMarkdown(child).replace(/\n/g, " ").replace(/\|/g, "\\|"))
              .join(" "),
          )
          .join(" | ")} |`,
    );
    const columns = children[0]?.content?.length ?? 1;
    return [rows[0], `|${" --- |".repeat(columns)}`, ...rows.slice(1)].join("\n");
  }
  if (node.type === "blockquote")
    return children
      .map((child) =>
        serializeBlock(child)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      )
      .join("\n> \n");
  if (isList(node)) {
    const parts: string[] = [];
    appendList(node, indent, parts);
    return parts.join("");
  }
  return inlineMarkdown(node)
    .replace(/^([ \t]*)([#>+-])(?=\s)/gm, "$1\\$2")
    .replace(/^(\d+)([.)])(?=\s)/gm, "$1\\$2");
}

// Unchanged blocks reuse their bytes; edits serialize only changed blocks in canonical form.
// The source fingerprint and surrounding whitespace survive editor transactions, with no reparse.
export function noteDocToMarkdown(doc: JSONContent): string {
  const blocks = doc.content ?? [];
  const tail = blocks.find((node) => node.attrs?.noteTail === true)?.attrs?.noteSuffix;
  return blocks
    .map((node, index) => {
      const unchanged = node.attrs?.noteFingerprint === fingerprint(node);
      const source =
        unchanged && typeof node.attrs?.noteSource === "string"
          ? node.attrs.noteSource
          : serializeBlock(node);
      const last = index === blocks.length - 1;
      // A block added after the old last one takes over the trailing text; the old last block
      // gets a paragraph break, or the new block would continue it as a lazy line.
      const suffix =
        node.attrs?.noteTail === true && !last
          ? "\n\n"
          : last && typeof tail === "string"
            ? tail
            : typeof node.attrs?.noteSuffix === "string"
              ? node.attrs.noteSuffix
              : last
                ? ""
                : "\n\n";
      return (
        (node.attrs?.notePrefix ?? "") +
        source +
        // Parser-owned source can include the boundary newline even with an empty suffix.
        (index < blocks.length - 1 && !suffix && !source.endsWith("\n") ? "\n\n" : suffix)
      );
    })
    .join("");
}
