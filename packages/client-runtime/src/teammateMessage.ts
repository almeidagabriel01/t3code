import {
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

const LEADING_STATUS =
  /^\s*[>*_-]*\s*status[\s*_]*:[\s*_]*(?:done|partial|blocked)\b[\s*_]*[.:;,–—-]?[ \t]*\r?\n?/i;

function toPart(entry: TeammateMessageEntry): TeammateMessagePart {
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

function legacyEntry(
  kind: TeammateMessageEntry["kind"],
  rawAttributes: string,
  text: string,
  filesList: string | null,
): TeammateMessageEntry | null {
  const attributes = attributesOf(rawAttributes);
  const name = attributes.from?.trim();
  const threadId = attributes.threadId;
  if (!name || !threadId) return null;
  const expects = attributes.expects_reply;
  const status = attributes.status === "blocked" ? ("blocked" as const) : teammateReplyStatus(text);
  return {
    kind,
    name,
    handle: attributes.handle ?? "",
    threadId: threadId as TeammateMessageEntry["threadId"],
    requestId: attributes.requestId ?? attributes.replyTo ?? "",
    ...(expects === undefined ? {} : { expectsReply: expects === "true" }),
    ...(status === undefined ? {} : { status }),
    files: filesList === null ? [] : [...assistantTransferPaths(filesList)],
    text,
  };
}

const SINGLE = /^<(t3_request|t3_reply)(\s[^>\n]*)?>\n([\s\S]*?)\n<\/\1>(?:\n([\s\S]*))?$/;
const GROUP_LEAD = /^Teammates answered your request;[^\n]*\n/;
const GROUP_REPLY = /<t3_reply(\s[^>\n]*)?>\n([\s\S]*?)\n<\/t3_reply>(?:\n|$)/y;

/** Messages stored before `context.teammate` existed: the envelope the server wrote, read back. */
function parseLegacyEnvelope(text: string): ReadonlyArray<TeammateMessageEntry> | null {
  const single = SINGLE.exec(text);
  if (single !== null) {
    const kind = single[1] === "t3_request" ? "request" : "reply";
    const { files } = splitAssistantTransferText(single[3]!);
    const entry = legacyEntry(kind, single[2] ?? "", single[4] ?? "", files);
    return entry === null ? null : [entry];
  }
  const lead = GROUP_LEAD.exec(text);
  if (lead === null) return null;
  const entries: Array<TeammateMessageEntry> = [];
  GROUP_REPLY.lastIndex = lead[0].length;
  for (let match = GROUP_REPLY.exec(text); match !== null; match = GROUP_REPLY.exec(text)) {
    const { body, files } = splitAssistantTransferText(match[2]!);
    const entry = legacyEntry("reply", match[1] ?? "", body, files);
    if (entry === null) return null;
    entries.push(entry);
    if (GROUP_REPLY.lastIndex >= text.length) break;
  }
  // Anything the blocks do not account for means this is not the server's envelope: keep it whole.
  return entries.length > 0 && GROUP_REPLY.lastIndex >= text.length ? entries : null;
}

/**
 * The teammates a user message comes from, or null for any other message. Reads the server's
 * attribution, else the envelope of an older agent send; anything it cannot read stays as text.
 */
export function resolveTeammateMessage(message: {
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly context?: Pick<OrchestrationMessageContext, "teammate"> | undefined;
}): ReadonlyArray<TeammateMessagePart> | null {
  if (message.role !== "user") return null;
  const entries =
    message.context?.teammate?.entries ??
    (message.createdBy === "agent" ? parseLegacyEnvelope(message.text) : null);
  return entries === null || entries.length === 0 ? null : entries.map(toPart);
}

/** Plain text for copy, previews and search: each teammate's words under their name. */
export function teammateMessagePlainText(parts: ReadonlyArray<TeammateMessagePart>): string {
  return parts.length === 1
    ? parts[0]!.text
    : parts.map((part) => `${part.name}:\n${part.text}`).join("\n\n");
}

// Agent-written markdown runs longer than a person's note; fold only what overflows a screen.
const LONG_MESSAGE_LINES = 28;
const LONG_MESSAGE_CHARS = 1_800;

/** Whether a teammate's words open folded, with the rest a tap away. */
export function teammateMessageIsLong(text: string): boolean {
  return text.length > LONG_MESSAGE_CHARS || text.split("\n").length > LONG_MESSAGE_LINES;
}
