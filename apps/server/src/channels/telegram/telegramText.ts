/**
 * The one place a message becomes Telegram text. Everything is sent with `parse_mode: "HTML"`:
 * assistant Markdown is converted from its syntax tree, T3's own phrases are only escaped, so a
 * title or a name never turns into markup. Each piece also carries a plain copy, sent when
 * Telegram refuses the HTML.
 */
import type { ChannelChoice } from "@t3tools/contracts";
import {
  parseMarkdown,
  type ListItem,
  type PhrasingContent,
  type RootContent,
  type Table,
} from "@t3tools/shared/markdownAst";
import { hostedThreadLink, parseThreadLinkHref } from "@t3tools/shared/threadLinks";

import {
  channelStrings,
  type ChannelStrings,
  type ResolvedChannelLanguage,
} from "../channelStrings.ts";
import { numberedChoices } from "../imessage/imessageText.ts";

/**
 * Telegram counts 4096 characters after entities are parsed. The HTML string's UTF-16 length is
 * never smaller than that, whichever unit Telegram counts in, so pieces are measured on it.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** A reply with nothing waiting on you is split into at most this many numbered parts. */
export const TELEGRAM_MAX_PARTS = 3;
/** Room for the widest part marker, "(3/3) ". */
const PART_MARKER_ROOM = 8;
/** Below this, the outline of the rest goes in a message of its own. */
const MIN_SUMMARY_ROOM = 300;
const SUMMARY_LINE_LIMIT = 200;
const WAITING_HEADING =
  /esperando|aguardando|waiting|preciso de (?:você|vc)|needs? (?:you|your)|decis(?:ão|ao|ões|oes|ion)|pergunta|question|ação necessária|acao necessaria|action (?:needed|required)/i;

export interface TelegramText {
  readonly html: string;
  /** What reaches the chat when Telegram rejects the HTML: tags gone, links as "label (url)". */
  readonly plain: string;
}

export interface TelegramMessageInput {
  readonly text: string;
  /** Starts the first line of every part; absent for the bot's own notices. */
  readonly senderName?: string | undefined;
  /** True when an assistant wrote the text; T3's own phrases are never read as Markdown. */
  readonly markdown?: boolean | undefined;
  readonly choices?: ReadonlyArray<ChannelChoice> | undefined;
  readonly language?: ResolvedChannelLanguage | undefined;
}

interface TelegramFormatOptions {
  /** Origin of the web link a thread link opens; without it, a thread link is its title in bold. */
  readonly hostedAppUrl?: string | undefined;
}

interface Context {
  readonly strings: ChannelStrings;
  readonly hostedAppUrl: string | undefined;
}

interface Unit {
  readonly html: string;
  /** One line of the outline sent in place of this block when the reply is cut down. */
  readonly summary: string;
  readonly node: RootContent | undefined;
  /** Pieces of at most `budget` characters, each with its tags closed. */
  readonly fit: (budget: number) => ReadonlyArray<string>;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeHtml(text).replace(/"/g, "&quot;");

const unescapeHtml = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function telegramPlainText(html: string): string {
  return unescapeHtml(
    html
      .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_match, href: string, label: string) =>
        label === href ? label : `${label} (${href})`,
      )
      .replace(/<\/?[a-z][^>]*>/g, ""),
  );
}

const webHref = (url: string) => {
  try {
    const parsed = new URL(url);
    // The address as written, so a bare link and its plain copy read the same; only the scheme is checked.
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

/** A node's visible text; a thread link without a written label reads as the word for thread. */
function textOf(node: RootContent | PhrasingContent, ctx: Context): string {
  if (node.type === "link") {
    const label = node.children.map((child) => textOf(child, ctx)).join("");
    return parseThreadLinkHref(node.url) !== null && (label.trim() === "" || label === node.url)
      ? ctx.strings.threadLink
      : label;
  }
  if (node.type === "image") return node.alt ?? "";
  if ("children" in node) {
    return (node.children as ReadonlyArray<RootContent>)
      .map((child) => textOf(child, ctx))
      .join(node.type === "list" || node.type === "table" || node.type === "tableRow" ? "\n" : "");
  }
  return "value" in node ? node.value : "";
}

function linkHtml(url: string, labelHtml: string, labelText: string, ctx: Context): string {
  const thread = parseThreadLinkHref(url);
  if (thread !== null) {
    const title = escapeHtml(
      labelText.trim() === "" || labelText === url ? ctx.strings.threadLink : labelText.trim(),
    );
    const href =
      thread.environmentId === null || ctx.hostedAppUrl === undefined
        ? undefined
        : hostedThreadLink(
            { environmentId: thread.environmentId, threadId: thread.threadId },
            ctx.hostedAppUrl,
          );
    return href === undefined
      ? `<b>${title}</b>`
      : `<b><a href="${escapeAttribute(href)}">${title}</a></b>`;
  }
  const href = webHref(url);
  if (href === undefined) return labelHtml;
  return `<a href="${escapeAttribute(href)}">${labelHtml === "" ? escapeHtml(url) : labelHtml}</a>`;
}

const inline = (nodes: ReadonlyArray<PhrasingContent>, ctx: Context): string =>
  nodes.map((node) => phrasing(node, ctx)).join("");

function phrasing(node: PhrasingContent, ctx: Context): string {
  switch (node.type) {
    case "text":
    case "html":
      return escapeHtml(node.value);
    case "strong":
      return `<b>${inline(node.children, ctx)}</b>`;
    case "emphasis":
      return `<i>${inline(node.children, ctx)}</i>`;
    case "delete":
      return `<s>${inline(node.children, ctx)}</s>`;
    case "inlineCode":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "break":
      return "\n";
    case "link":
      return linkHtml(node.url, inline(node.children, ctx), textOf(node, ctx), ctx);
    case "image":
      return linkHtml(node.url, escapeHtml(node.alt ?? ""), node.alt ?? "", ctx);
    default:
      return escapeHtml(textOf(node, ctx));
  }
}

const codeHtml = (code: string, lang: string | null | undefined) =>
  lang !== null && lang !== undefined && /^[\w#+.-]{1,32}$/.test(lang)
    ? `<pre><code class="language-${lang}">${escapeHtml(code)}</code></pre>`
    : `<pre>${escapeHtml(code)}</pre>`;

function listItemHtml(item: ListItem, marker: string, ctx: Context, depth: number): string {
  const box = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
  const body = item.children
    .map((child) => blockHtml(child, ctx, child.type === "list" ? depth + 1 : depth))
    .join("\n");
  return `${"    ".repeat(depth)}${marker} ${box}${body}`;
}

const listMarker = (
  list: {
    readonly ordered?: boolean | null | undefined;
    readonly start?: number | null | undefined;
  },
  index: number,
) => (list.ordered === true ? `${(list.start ?? 1) + index}.` : "•");

/** A table reads as a list: one line per row, its first cell in bold, the rest "header: value". */
function tableRowsHtml(table: Table, ctx: Context): ReadonlyArray<string> {
  const [head, ...rows] = table.children;
  if (head === undefined) return [];
  const headers = head.children.map((cell) => textOf(cell, ctx).trim());
  if (rows.length === 0) return [`• ${headers.map(escapeHtml).join(" · ")}`];
  return rows.map((row) => {
    const [first, ...rest] = row.children.map((cell) => inline(cell.children, ctx).trim());
    const values = rest.flatMap((value, index) => {
      if (value === "") return [];
      const header = headers[index + 1];
      return [header === undefined || header === "" ? value : `${escapeHtml(header)}: ${value}`];
    });
    return `• ${[first === undefined || first === "" ? [] : [`<b>${first}</b>`], values].flat().join(" · ")}`;
  });
}

function blockHtml(node: RootContent, ctx: Context, depth = 0): string {
  switch (node.type) {
    case "paragraph":
      return inline(node.children, ctx);
    case "heading":
      return `<b>${inline(node.children, ctx)}</b>`;
    case "code":
      return codeHtml(node.value, node.lang);
    case "blockquote":
      return `<blockquote>${node.children.map((child) => blockHtml(child, ctx)).join("\n")}</blockquote>`;
    case "list":
      return node.children
        .map((item, index) => listItemHtml(item, listMarker(node, index), ctx, depth))
        .join("\n");
    case "listItem":
      return listItemHtml(node, "•", ctx, depth);
    case "table":
      return tableRowsHtml(node, ctx).join("\n");
    case "thematicBreak":
      return "──────";
    case "definition":
    case "footnoteDefinition":
    case "yaml":
      return "";
    default:
      return escapeHtml(textOf(node, ctx));
  }
}

const clip = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.lastIndexOf(" ", limit - 1);
  return `${flat.slice(0, cut > limit / 2 ? cut : limit - 1)}…`;
};
const firstSentence = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return /^.+?[.!?…](?=\s|$)/.exec(flat)?.[0] ?? flat;
};
const leadLine = (text: string) => escapeHtml(clip(firstSentence(text), SUMMARY_LINE_LIMIT));

function summaryOf(node: RootContent, ctx: Context): string {
  switch (node.type) {
    case "heading":
      return `<b>${escapeHtml(clip(textOf(node, ctx), SUMMARY_LINE_LIMIT))}</b>`;
    case "code":
      return escapeHtml(ctx.strings.codeSummary(node.value.split("\n").length));
    case "list":
    case "table": {
      const items = node.type === "list" ? node.children : node.children.slice(1);
      const first = items[0];
      if (first === undefined) return "";
      const more = items.length > 1 ? ` (+${items.length - 1})` : "";
      return `• ${leadLine(textOf(first, ctx).replace(/\n/g, " · "))}${more}`;
    }
    case "thematicBreak":
    case "definition":
    case "footnoteDefinition":
      return "";
    default:
      return leadLine(textOf(node, ctx));
  }
}

/** Splits near the middle, at a line break or a space when there is one; never inside a surrogate pair. */
function halve(source: string): readonly [string, string] {
  const middle = Math.floor(source.length / 2);
  const nearest = (separator: string) => {
    const before = source.lastIndexOf(separator, middle);
    const after = source.indexOf(separator, middle);
    const candidates = [before, after].filter((index) => index > 0 && index < source.length - 1);
    return candidates.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
  };
  let cut = nearest("\n") ?? nearest(" ") ?? Math.max(1, middle);
  if (/[\uD800-\uDBFF]/.test(source.charAt(cut - 1)) && cut > 1) cut -= 1;
  return [source.slice(0, cut).trimEnd(), source.slice(cut).trimStart()];
}

/** Each half is shorter than `source`, so the recursion ends. */
const fitByHalves = (
  source: string,
  render: (source: string) => ReadonlyArray<Unit>,
  budget: number,
): ReadonlyArray<string> =>
  halve(source).flatMap((half) => render(half).flatMap((unit) => unit.fit(budget)));

function plainUnits(text: string): ReadonlyArray<Unit> {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => plainUnit(paragraph));
}

const plainUnit = (source: string): Unit => {
  const html = escapeHtml(source);
  return {
    html,
    summary: leadLine(source),
    node: undefined,
    fit: (budget) => (html.length <= budget ? [html] : fitByHalves(source, plainUnits, budget)),
  };
};

/** Packs whole lines into code blocks of at most `budget`; a longer line is cut by halves. */
function fitCode(code: string, lang: string | null | undefined, budget: number) {
  const pieces: Array<string> = [];
  let current: Array<string> = [];
  const flush = () => {
    if (current.length > 0) pieces.push(codeHtml(current.join("\n"), lang));
    current = [];
  };
  const lines = code.split("\n");
  while (lines.length > 0) {
    const line = lines.shift()!;
    if (codeHtml([...current, line].join("\n"), lang).length <= budget) {
      current.push(line);
      continue;
    }
    flush();
    if (codeHtml(line, lang).length <= budget) current.push(line);
    else if (line.length > 1) lines.unshift(...halve(line));
    else pieces.push(codeHtml(line, lang));
  }
  flush();
  return pieces;
}

function markdownUnits(text: string, ctx: Context): ReadonlyArray<Unit> {
  return parseMarkdown(text).children.flatMap((node): ReadonlyArray<Unit> => {
    const html = blockHtml(node, ctx);
    if (html.trim() === "") return [];
    const source = text.slice(node.position?.start.offset ?? 0, node.position?.end.offset);
    const fit = (budget: number): ReadonlyArray<string> => {
      if (html.length <= budget) return [html];
      switch (node.type) {
        case "code":
          return fitCode(node.value, node.lang, budget);
        case "list":
          return node.children.flatMap((item, index) => {
            const itemHtml = listItemHtml(item, listMarker(node, index), ctx, 0);
            if (itemHtml.length <= budget) return [itemHtml];
            const itemSource = text.slice(item.position?.start.offset, item.position?.end.offset);
            return fitByHalves(itemSource, (half) => markdownUnits(half, ctx), budget);
          });
        case "table":
          return tableRowsHtml(node, ctx).flatMap((row) =>
            row.length <= budget ? [row] : plainUnit(telegramPlainText(row)).fit(budget),
          );
        default:
          return fitByHalves(source, (half) => markdownUnits(half, ctx), budget);
      }
    };
    return [{ html, summary: summaryOf(node, ctx), node, fit }];
  });
}

/** Groups fragments, in order, into messages of at most `budget` characters. */
function pack(fragments: ReadonlyArray<string>, budget: number): Array<Array<string>> {
  const groups: Array<Array<string>> = [];
  let size = 0;
  for (const fragment of fragments) {
    const last = groups.at(-1);
    if (last !== undefined && size + 2 + fragment.length <= budget) {
      last.push(fragment);
      size += 2 + fragment.length;
    } else {
      groups.push([fragment]);
      size = fragment.length;
    }
  }
  return groups;
}

/**
 * Where the part that waits on you starts: the last heading that names it ("Esperando você",
 * "Decision", "Question"…), else a closing paragraph that asks a question, with only the lists
 * that answer it after it.
 */
function waitingStart(units: ReadonlyArray<Unit>, ctx: Context): number | undefined {
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const node = units[index]!.node;
    if (node?.type === "heading" && WAITING_HEADING.test(textOf(node, ctx))) return index;
  }
  let index = units.length - 1;
  while (index >= 0 && units[index]!.node?.type === "list") index -= 1;
  const node = index >= 0 ? units[index]!.node : undefined;
  return node?.type === "paragraph" && /\?\s*$/.test(textOf(node, ctx)) ? index : undefined;
}

function outline(units: ReadonlyArray<Unit>, room: number, strings: ChannelStrings): string {
  const note = `<i>${escapeHtml(strings.summaryNote)}</i>`;
  const lines: Array<string> = [];
  let size = note.length;
  for (const { summary } of units) {
    if (summary === "") continue;
    if (size + summary.length + 1 > room) break;
    lines.push(summary);
    size += summary.length + 1;
  }
  return [...lines, note].join("\n");
}

const piece = (html: string): TelegramText => ({ html, plain: telegramPlainText(html) });

/**
 * The messages one delivery is sent as, the same ones on every retry. A reply that fits goes as
 * one message. A longer one with a part that waits on you (a question, a decision, choices) sends
 * that part whole after an outline of the rest; any other is split into numbered parts.
 */
export function formatTelegramMessages(
  input: TelegramMessageInput,
  options: TelegramFormatOptions = {},
): Array<TelegramText> {
  const strings = channelStrings(input.language ?? "en");
  const ctx: Context = { strings, hostedAppUrl: options.hostedAppUrl };
  const units = input.markdown === true ? markdownUnits(input.text, ctx) : plainUnits(input.text);
  const choices =
    input.choices !== undefined && input.choices.length > 0
      ? plainUnit(numberedChoices(input.choices, strings.replyWithNumber))
      : undefined;
  const prefix = input.senderName === undefined ? "" : `<b>${escapeHtml(input.senderName)}:</b> `;
  const all = choices === undefined ? units : [...units, choices];
  const whole = all.map((unit) => unit.html).join("\n\n");
  if (prefix.length + whole.length <= TELEGRAM_MESSAGE_LIMIT) return [piece(prefix + whole)];

  const budget = TELEGRAM_MESSAGE_LIMIT - prefix.length - PART_MARKER_ROOM;
  const numbered = (groups: ReadonlyArray<ReadonlyArray<string>>) =>
    groups.map((group, index) =>
      piece(
        `${prefix}${groups.length > 1 ? `(${index + 1}/${groups.length}) ` : ""}${group.join("\n\n")}`,
      ),
    );

  const start = input.markdown === true ? waitingStart(units, ctx) : undefined;
  const waiting = [
    ...(start === undefined ? [] : units.slice(start)),
    ...(choices ? [choices] : []),
  ];
  const rest = units.slice(0, start ?? units.length);
  if (waiting.length > 0 && rest.length > 0) {
    const waitingHtml = waiting.map((unit) => unit.html).join("\n\n");
    const room = budget - waitingHtml.length - 2;
    if (room >= MIN_SUMMARY_ROOM)
      return [piece(`${prefix}${outline(rest, room, strings)}\n\n${waitingHtml}`)];
    const waitingParts = pack(
      waiting.flatMap((unit) => unit.fit(budget)),
      budget,
    );
    return numbered([[outline(rest, budget, strings)], ...waitingParts]);
  }

  // Fragments leave room for the note that ends a reply too long for the parts it may use.
  const note = `<i>${escapeHtml(strings.truncatedNote)}</i>`;
  const fragments = all.flatMap((unit) => unit.fit(budget - note.length - 2));
  const groups = pack(fragments, budget);
  if (groups.length <= TELEGRAM_MAX_PARTS) return numbered(groups);
  const kept = groups.slice(0, TELEGRAM_MAX_PARTS - 1);
  const used = kept.reduce((count, group) => count + group.length, 0);
  const [last = []] = pack(fragments.slice(used), budget - note.length - 2);
  return numbered([...kept, [...last, note]]);
}
