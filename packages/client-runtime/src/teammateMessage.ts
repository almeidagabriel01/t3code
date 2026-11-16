import {
  assistantIdFromThreadId,
  assistantTransferPaths,
  splitAssistantTransferText,
  type OrchestrationMessageContext,
  type OrchestrationV2Actor,
  type TeammateMessageEntry,
  type TeammateReplyStatus,
  teammateReplyStatus,
} from "@t3tools/contracts";

/** One teammate's part of a message, ready to show: who, what, and the words without the envelope. */
export interface TeammateMessagePart {
  readonly kind: TeammateMessageEntry["kind"];
  readonly name: string;
  readonly handle: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly expectsReply: boolean | undefined;
  readonly status: TeammateReplyStatus | undefined;
  readonly files: ReadonlyArray<string>;
  /** The body, minus a leading "Status: …" that the status chip already shows. */
  readonly text: string;
}

export const TEAMMATE_STATUS_LABEL = {
  done: "Done",
  partial: "Partial",
  blocked: "Blocked",
} satisfies Record<TeammateReplyStatus, string>;

// One leading class, not `\s*[>*_-]*\s*`: adjacent optional runs backtrack quadratically on blank text.
// A note in parentheses after the status (`partial (em andamento)`) belongs to the status line.
const LEADING_STATUS =
  /^[\s>*_-]*status[\s*_]*:[\s*_]*(?:done|partial|blocked)\b(?:[ \t]*\([^)\n]*\))?[\s*_]*[.:;,–—-]?[ \t]*\r?\n?/i;

/** An entry with its words in hand, from the server's offsets or an older envelope's tags. */
type ReadEntry = Omit<TeammateMessageEntry, "bodyStart" | "bodyEnd"> & { readonly text: string };

function toPart(entry: ReadEntry): TeammateMessagePart {
  const status =
    entry.status ?? (entry.kind === "reply" ? teammateReplyStatus(entry.text) : undefined);
  const shown = status === undefined ? entry.text : entry.text.replace(LEADING_STATUS, "");
  return {
    kind: entry.kind,
    name: entry.name,
    handle: entry.handle,
    threadId: entry.threadId,
    requestId: entry.requestId,
    expectsReply: entry.expectsReply,
    status,
    files: entry.files,
    // A reply that was only its status line still says something.
    text: shown.trim() === "" ? entry.text : shown,
  };
}

const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;
const unescapeAttribute = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

function attributesOf(raw: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [, key, value] of raw.matchAll(ATTRIBUTE)) found[key!] = unescapeAttribute(value!);
  return found;
}

// The name is the sender's claim; clients name a teammate from the assistant directory instead.
function legacyEntry(
  kind: TeammateMessageEntry["kind"],
  rawAttributes: string,
  text: string,
  filesList: string | null,
): ReadEntry | null {
  const attributes = attributesOf(rawAttributes);
  const name = attributes.from?.trim();
  const threadId = attributes.threadId;
  if (!name || !threadId) return null;
  const expects = attributes.expects_reply;
  const status =
    kind !== "reply"
      ? undefined
      : attributes.status === "blocked"
        ? ("blocked" as const)
        : teammateReplyStatus(text);
  return {
    kind,
    name: "",
    handle: attributes.handle ?? "",
    threadId: threadId as TeammateMessageEntry["threadId"],
    requestId: attributes.requestId ?? attributes.replyTo ?? "",
    ...(expects === undefined ? {} : { expectsReply: expects === "true" }),
    ...(status === undefined ? {} : { status }),
    files: filesList === null ? [] : [...assistantTransferPaths(filesList)],
    text,
  };
}

// Quoted values may hold ">" and newlines: the server escapes only &, " and <.
const ATTRIBUTES = String.raw`((?:\s+[\w-]+="[^"]*")*)\s*`;
const SINGLE = new RegExp(
  String.raw`^<(t3_request|t3_reply)${ATTRIBUTES}>\n([\s\S]*?)\n<\/\1>(?:\n([\s\S]*))?$`,
);
const GROUP_LEAD = /^Teammates answered your request;[^\n]*\n/;
const GROUP_REPLY = new RegExp(
  String.raw`<t3_reply${ATTRIBUTES}>\n([\s\S]*?)\n<\/t3_reply>(?:\n|$)`,
  "y",
);

const replyMessageId = (requestId: string) => `assistant-reply:${requestId}`;

/**
 * Messages from a server without `context.teammate`: the envelope the server wrote, read back only
 * where the server's own marks prove it. The server wrapped every send of an assistant in its own
 * envelope from that assistant's thread, under ids it chose; any other text keeps its tags.
 */
function parseLegacyEnvelope(message: TeammateSource): ReadonlyArray<ReadEntry> | null {
  const { text, senderThreadId, id } = message;
  if (senderThreadId === undefined || assistantIdFromThreadId(senderThreadId) === null) return null;
  const single = SINGLE.exec(text);
  if (single !== null) {
    const kind = single[1] === "t3_request" ? "request" : "reply";
    const { files } = splitAssistantTransferText(single[3]!);
    const entry = legacyEntry(kind, single[2] ?? "", single[4] ?? "", files);
    if (entry === null || entry.threadId !== senderThreadId) return null;
    // A note that expects no reply carries no request id; its sender alone vouches for it.
    const expectedId =
      kind === "reply" ? replyMessageId(entry.requestId) : entry.requestId || undefined;
    return expectedId === undefined || expectedId === id ? [entry] : null;
  }
  const lead = GROUP_LEAD.exec(text);
  if (lead === null || id === undefined || !id.startsWith(replyMessageId(""))) return null;
  const groupId = id.slice(replyMessageId("").length);
  const entries: Array<ReadEntry> = [];
  GROUP_REPLY.lastIndex = lead[0].length;
  for (let match = GROUP_REPLY.exec(text); match !== null; match = GROUP_REPLY.exec(text)) {
    const { body, files } = splitAssistantTransferText(match[2]!);
    const entry = legacyEntry("reply", match[1] ?? "", body, files);
    // Each block answers this group's request to that teammate, once, as the server numbered them.
    // Bodies were not escaped, so a teammate's words can close their block and forge another's.
    if (
      entry === null ||
      assistantIdFromThreadId(entry.threadId) === null ||
      entry.requestId !== `${groupId}:to:${encodeURIComponent(entry.threadId)}` ||
      entries.some((seen) => seen.threadId === entry.threadId)
    ) {
      return null;
    }
    entries.push(entry);
    if (GROUP_REPLY.lastIndex >= text.length) break;
  }
  // Anything the blocks do not account for means this is not the server's envelope: keep it whole.
  return entries.length > 0 &&
    GROUP_REPLY.lastIndex >= text.length &&
    entries.some((entry) => entry.threadId === senderThreadId)
    ? entries
    : null;
}

/**
 * The teammates a user message comes from, or null for any other message. Reads the server's
 * attribution, else the envelope of an older agent send; anything it cannot read stays as text.
 */
export function resolveTeammateMessage(
  message: TeammateSource,
): ReadonlyArray<TeammateMessagePart> | null {
  const cached = resolved.get(message);
  if (cached !== undefined) return cached;
  const parts = resolveUncached(message);
  resolved.set(message, parts);
  return parts;
}

interface TeammateSource {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly senderThreadId?: string | undefined;
  readonly context?: Pick<OrchestrationMessageContext, "teammate"> | undefined;
}

// Rows, presence and the timeline all ask about the same stored (immutable) message objects.
const resolved = new WeakMap<TeammateSource, ReadonlyArray<TeammateMessagePart> | null>();

function resolveUncached(message: TeammateSource): ReadonlyArray<TeammateMessagePart> | null {
  if (message.role !== "user") return null;
  const teammate = message.context?.teammate;
  const entries =
    teammate !== undefined
      ? readStoredEntries(message.text, teammate.entries)
      : message.createdBy === "agent"
        ? parseLegacyEnvelope(message)
        : null;
  return entries === null || entries.length === 0 ? null : entries.map(toPart);
}

/** Each entry's words, cut from the text; a range the text does not hold leaves it whole. */
function readStoredEntries(
  text: string,
  entries: ReadonlyArray<TeammateMessageEntry>,
): ReadonlyArray<ReadEntry> | null {
  const read: Array<ReadEntry> = [];
  for (const { bodyStart, bodyEnd, ...entry } of entries) {
    if (bodyStart < 0 || bodyStart > bodyEnd || bodyEnd > text.length) return null;
    read.push({ ...entry, text: text.slice(bodyStart, bodyEnd) });
  }
  return read;
}

/** Plain text for copy, previews and search: each teammate's words under their name. */
export function teammateMessagePlainText(parts: ReadonlyArray<TeammateMessagePart>): string {
  return parts.length === 1
    ? parts[0]!.text
    : parts.map((part) => `${part.name || "Assistant"}:\n${part.text}`).join("\n\n");
}
