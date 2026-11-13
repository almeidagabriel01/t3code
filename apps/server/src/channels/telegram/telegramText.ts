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
/** Headings that hand something to the user, not ones that report on it ("Decisões tomadas"). */
const WAITING_HEADING =
  /esperando (?:por )?(?:você|vc|sua|seu)|aguardando (?:você|vc|sua|seu)|preciso de (?:você|vc|sua|seu)|waiting (?:on|for) you|needs? (?:you|your)|decis(?:ão|ao|ões|oes) pendentes?|pending decisions?|decision needed|^\s*perguntas?\b|questions? for you|^\s*open questions?\b|ação necessária|acao necessaria|action (?:needed|required)/i;

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
  /** Telegram refuses a tag nested in itself, so bold and quotes are never reopened inside one. */
  readonly bold?: boolean;
  readonly quote?: boolean;
}

const bold = (inner: (ctx: Context) => string, ctx: Context) =>
  ctx.bold === true ? inner(ctx) : `<b>${inner({ ...ctx, bold: true })}</b>`;

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
    return bold(
      () => (href === undefined ? title : `<a href="${escapeAttribute(href)}">${title}</a>`),
      ctx,
    );
  }
  const href = webHref(url);
  if (href === undefined) {
    // An address or a phone number is still worth reading; it is never made a link.
    const contact = /^(?:mailto|tel):(.+)$/i.exec(url)?.[1];
    return contact === undefined || labelText.trim() === contact
      ? labelHtml
      : `${labelHtml} (${escapeHtml(contact)})`;
  }
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
      return bold((inner) => inline(node.children, inner), ctx);
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

/** A nested quote joins its parent; a code block inside one is set apart, since a quote cannot hold it. */
function quoteHtml(children: ReadonlyArray<RootContent>, ctx: Context): string {
  if (ctx.quote === true) return children.map((child) => blockHtml(child, ctx)).join("\n");
  const inner = { ...ctx, quote: true };
  const parts: Array<string> = [];
  let quoted: Array<string> = [];
  const close = () => {
    if (quoted.length > 0) parts.push(`<blockquote>${quoted.join("\n")}</blockquote>`);
    quoted = [];
  };
  for (const child of children) {
    if (child.type === "code") {
      close();
      parts.push(codeHtml(child.value, child.lang));
    } else quoted.push(blockHtml(child, inner));
  }
  close();
  return parts.join("\n");
}

function blockHtml(node: RootContent, ctx: Context, depth = 0): string {
  switch (node.type) {
    case "paragraph":
      return inline(node.children, ctx);
    case "heading":
      return bold((inner) => inline(node.children, inner), ctx);
    case "code":
      return codeHtml(node.value, node.lang);
    case "blockquote":
      return quoteHtml(node.children, ctx);
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
  const space = flat.lastIndexOf(" ", limit - 1);
  let cut = space > limit / 2 ? space : limit - 1;
  if (/[\uD800-\uDBFF]/.test(flat.charAt(cut - 1))) cut -= 1;
  return `${flat.slice(0, cut)}…`;
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
function halve(source: string, trim = true): readonly [string, string] {
  const middle = Math.floor(source.length / 2);
  const nearest = (separator: string) => {
    const before = source.lastIndexOf(separator, middle);
    const after = source.indexOf(separator, middle);
    const candidates = [before, after].filter((index) => index > 0 && index < source.length - 1);
    return candidates.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
  };
  let cut = nearest("\n") ?? nearest(" ") ?? Math.max(1, middle);
  if (/[\uD800-\uDBFF]/.test(source.charAt(cut - 1)) && cut > 1) cut -= 1;
  const [head, tail] = [source.slice(0, cut), source.slice(cut)];
  return trim ? [head.trimEnd(), tail.trimStart()] : [head, tail];
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
    else if (line.length > 1) lines.unshift(...halve(line, false));
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
          return joinLines(
            node.children.flatMap((item, index) => {
              const itemHtml = listItemHtml(item, listMarker(node, index), ctx, 0);
              if (itemHtml.length <= budget) return [itemHtml];
              const itemSource = text.slice(item.position?.start.offset, item.position?.end.offset);
              return fitByHalves(itemSource, (half) => markdownUnits(half, ctx), budget);
            }),
            budget,
          );
        case "table":
          return joinLines(
            tableRowsHtml(node, ctx).flatMap((row) =>
              row.length <= budget ? [row] : plainUnit(telegramPlainText(row)).fit(budget),
            ),
            budget,
          );
        default:
          return fitByHalves(source, (half) => markdownUnits(half, ctx), budget);
      }
    };
    return [{ html, summary: summaryOf(node, ctx), node, fit }];
  });
}

/** Rejoins the rows of a split list or table one per line, as they read before the split. */
function joinLines(rows: ReadonlyArray<string>, budget: number): ReadonlyArray<string> {
  return pack(rows, budget, "\n").map((group) => group.join("\n"));
}

/** Groups fragments, in order, into messages of at most `budget` characters. */
function pack(
  fragments: ReadonlyArray<string>,
  budget: number,
  separator = "\n\n",
): Array<Array<string>> {
  const groups: Array<Array<string>> = [];
  let size = 0;
  for (const fragment of fragments) {
    const last = groups.at(-1);
    if (last !== undefined && size + separator.length + fragment.length <= budget) {
      last.push(fragment);
      size += separator.length + fragment.length;
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
  // Markdown that renders to nothing (only link definitions) is sent as written, not as an empty message.
  const parsed = input.markdown === true ? markdownUnits(input.text, ctx) : [];
  const units = parsed.length > 0 ? parsed : plainUnits(input.text);
  const choices =
    input.choices !== undefined && input.choices.length > 0
      ? plainUnit(numberedChoices(input.choices, strings.replyWithNumber))
      : undefined;
  const prefix = input.senderName === undefined ? "" : `<b>${escapeHtml(input.senderName)}:</b> `;
  const all = choices === undefined ? units : [...units, choices];
  if (all.length === 0) return [];
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
