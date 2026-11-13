import {
  ASSISTANT_GROUP_EVERYONE,
  ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION,
  ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY,
  assistantGroupAddress,
  assistantGroupMentions,
  foldAssistantGroupText,
  type Assistant,
  type AssistantTeam,
  type AssistantGroupMessage,
  type AssistantGroupMessageId,
  type AssistantGroupTask,
  type AssistantGroupTaskId,
  type AssistantGroupTaskStatus,
  type AssistantGroupsEvent,
  type AssistantGroupsHistoryResult,
} from "@t3tools/contracts";

export interface AssistantGroupChatState {
  readonly messages: ReadonlyMap<AssistantGroupMessageId, AssistantGroupMessage>;
  readonly tasks: ReadonlyMap<AssistantGroupTaskId, AssistantGroupTask>;
  /** Older messages exist than the ones loaded. */
  readonly hasMore: boolean;
}

/** Folds one event; the first is always a snapshot, so state starts from it. */
export function applyAssistantGroupsEvent(
  state: AssistantGroupChatState | null,
  event: AssistantGroupsEvent,
): AssistantGroupChatState | null {
  if (event.type === "snapshot") {
    return {
      messages: new Map(event.messages.map((message) => [message.id, message])),
      tasks: new Map(event.tasks.map((task) => [task.id, task])),
      hasMore: event.hasMore,
    };
  }
  if (state === null) return null;
  if (event.type === "message") {
    return { ...state, messages: new Map(state.messages).set(event.message.id, event.message) };
  }
  const current = state.tasks.get(event.task.id);
  // An older update that arrives late must not undo a newer one.
  if (current !== undefined && current.updatedAt > event.task.updatedAt) return state;
  return { ...state, tasks: new Map(state.tasks).set(event.task.id, event.task) };
}

/** Merges an older page; what the state already holds wins for tasks that changed since. */
export function applyAssistantGroupHistory(
  state: AssistantGroupChatState,
  page: AssistantGroupsHistoryResult,
): AssistantGroupChatState {
  // A page loaded before a clear or an undo names messages the chat no longer has: only what
  // lies before the oldest message the live chat holds can still be older history.
  const oldest = oldestAssistantGroupSeq(state);
  if (oldest === null) return state;
  const messages = new Map(state.messages);
  for (const message of page.messages)
    if (!messages.has(message.id) && message.seq < oldest) messages.set(message.id, message);
  const tasks = new Map(state.tasks);
  for (const task of page.tasks) if (!tasks.has(task.id)) tasks.set(task.id, task);
  return { messages, tasks, hasMore: page.hasMore };
}

export function oldestAssistantGroupSeq(state: AssistantGroupChatState): number | null {
  let oldest: number | null = null;
  for (const message of state.messages.values()) {
    if (oldest === null || message.seq < oldest) oldest = message.seq;
  }
  return oldest;
}

export type AssistantGroupFeedRole =
  /** The user, an agent or a schedule asking for work. */
  | "request"
  /** A member speaking. */
  | "answer"
  /** A routing note or a notice: a small centered line. */
  | "note"
  /** A new conversation or a compaction: a divider; older messages stay above it. */
  | "boundary";

export interface AssistantGroupFeedRow {
  readonly message: AssistantGroupMessage;
  readonly role: AssistantGroupFeedRole;
  /** Cards shown under the message: its open tasks, or the task a member's message answers. */
  readonly tasks: ReadonlyArray<AssistantGroupTask>;
}

function roleOf(message: AssistantGroupMessage): AssistantGroupFeedRole {
  if (message.kind === "boundary") return "boundary";
  if (message.kind !== "message") return "note";
  return message.author === "assistant" ? "answer" : "request";
}

/**
 * The chat in seq order. A task that no member has answered yet sits under the request that opened
 * it; once a member answers, its card moves to that member's latest message for the task.
 */
export function assistantGroupFeed(
  state: AssistantGroupChatState,
): ReadonlyArray<AssistantGroupFeedRow> {
  const messages = [...state.messages.values()].sort((a, b) => a.seq - b.seq);
  const answerOf = new Map<AssistantGroupTaskId, AssistantGroupMessageId>();
  for (const message of messages) {
    if (
      roleOf(message) === "answer" &&
      message.taskId !== null &&
      state.tasks.has(message.taskId)
    ) {
      answerOf.set(message.taskId, message.id);
    }
  }
  const byMessage = new Map<AssistantGroupMessageId, AssistantGroupTask[]>();
  const tasks = [...state.tasks.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const task of tasks) {
    const holder = answerOf.get(task.id) ?? task.requestMessageId;
    byMessage.set(holder, [...(byMessage.get(holder) ?? []), task]);
  }
  return messages.map((message) => ({
    message,
    role: roleOf(message),
    tasks: byMessage.get(message.id) ?? [],
  }));
}

type Recipient = Pick<Assistant, "id" | "name" | "handle">;

function joinNames(names: ReadonlyArray<string>): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Who a draft will reach, for the line under the composer, in the server's order: leading
 * mentions, the member it replies to, the only member, then the lead. The server still decides.
 */
export function assistantGroupRecipientsPreview(
  text: string,
  members: ReadonlyArray<Recipient>,
  lead: Recipient | null,
  replyTo: string | null = null,
): string | null {
  if (text.trim() === "") return null;
  const picked = assistantGroupAddress(text, members);
  if (picked !== null) {
    return picked.length === members.length && members.length > 1
      ? "To everyone"
      : `To ${joinNames(picked.map((member) => member.name))}`;
  }
  if (replyTo !== null) return `To ${replyTo}`;
  if (members.length === 1) return `To ${members[0]!.name}`;
  return lead === null ? "Waits for a lead" : `${lead.name} (lead) will route it`;
}

export type AssistantGroupMentionOption<M extends Recipient> =
  | { readonly kind: "member"; readonly member: M }
  | { readonly kind: "everyone" };

export interface AssistantGroupMentionQuery {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** What the picker may hold after the `@`: up to three words, none trailing (a picked mention ends in a space). */
const MENTION_BEING_TYPED = /(?:^|[\s(])@((?:[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+){0,2})?)$/u;

/** The `@word` the caret is in, anywhere a mention could start. */
export function assistantGroupMentionQuery(
  text: string,
  caret: number,
): AssistantGroupMentionQuery | null {
  const match = MENTION_BEING_TYPED.exec(text.slice(0, caret));
  if (match === null) return null;
  return {
    start: caret - match[1]!.length - 1,
    end: caret,
    query: foldAssistantGroupText(match[1]!),
  };
}

/** The text cut into plain and mention runs, for highlighting; same parser as the server's. */
export function assistantGroupTextParts(
  text: string,
  members: ReadonlyArray<Pick<Assistant, "handle" | "name">>,
): ReadonlyArray<{ readonly start: number; readonly text: string; readonly mention: boolean }> {
  const parts: Array<{ start: number; text: string; mention: boolean }> = [];
  let at = 0;
  for (const found of assistantGroupMentions(text, members)) {
    if (found.start > at)
      parts.push({ start: at, text: text.slice(at, found.start), mention: false });
    parts.push({ start: found.start, text: text.slice(found.start, found.end), mention: true });
    at = found.end;
  }
  if (at < text.length) parts.push({ start: at, text: text.slice(at), mention: false });
  return parts;
}

// Spans a mention link must not enter: code, links (a link inside one would nest), autolinks, bare URLs.
const PROTECTED_SPAN = /(`+)[\s\S]*?\1|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|https?:\/\/\S+/g;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Scheme of the link a member mention becomes; clients style it and never navigate. */
export const ASSISTANT_MENTION_HREF = "t3-mention:mention";

/** Markdown with each member `@mention` made a mention link, except in code spans and fenced blocks. */
export function assistantGroupMarkdownMentions(
  markdown: string,
  members: ReadonlyArray<Pick<Assistant, "handle" | "name">>,
): string {
  if (!markdown.includes("@")) return markdown;
  const link = (text: string) =>
    assistantGroupTextParts(text, members)
      .map((part) => (part.mention ? `[${part.text}](${ASSISTANT_MENTION_HREF})` : part.text))
      .join("");
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = CODE_FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length)
          fence = null;
        return line;
      }
      if (marker !== undefined) {
        fence = marker;
        return line;
      }
      let out = "";
      let at = 0;
      for (const code of line.matchAll(PROTECTED_SPAN)) {
        out += link(line.slice(at, code.index)) + code[0];
        at = code.index + code[0].length;
      }
      return out + link(line.slice(at));
    })
    .join("\n");
}

/** Members whose handle or name starts with the query, then `@everyone` when it fits. */
export function assistantGroupMentionOptions<M extends Recipient>(
  query: string,
  members: ReadonlyArray<M>,
): ReadonlyArray<AssistantGroupMentionOption<M>> {
  const options: AssistantGroupMentionOption<M>[] = members
    .filter(
      (member) =>
        member.handle.startsWith(query) ||
        foldAssistantGroupText(member.name).replace(/\s+/g, " ").startsWith(query) ||
        foldAssistantGroupText(member.name).replace(/\s+/g, "").startsWith(query),
    )
    .map((member) => ({ kind: "member", member }));
  if (ASSISTANT_GROUP_EVERYONE.startsWith(query)) options.push({ kind: "everyone" });
  return options;
}

/** The text with the `@word` replaced by the chosen mention and a space, and where the caret goes. */
export function insertAssistantGroupMention(
  text: string,
  mention: AssistantGroupMentionQuery,
  option: AssistantGroupMentionOption<Recipient>,
): { readonly text: string; readonly caret: number } {
  const handle = option.kind === "everyone" ? ASSISTANT_GROUP_EVERYONE : option.member.handle;
  const inserted = `@${handle} `;
  const rest = text.slice(mention.end).replace(/^ /, "");
  return {
    text: `${text.slice(0, mention.start)}${inserted}${rest}`,
    caret: mention.start + inserted.length,
  };
}

export const ASSISTANT_GROUP_STATUS_LABEL: Record<AssistantGroupTaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  paused: "Paused",
  cancelled: "Cancelled",
  failed: "Failed",
};

const PAUSE_REASON_LABEL: Record<string, string> = {
  stopped: "Stopped",
  no_delivery: `${ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY} hand-offs without a delivery`,
  handoff_limit: `${ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION} hand-offs since your last action`,
  member_removed: "Owner left the group",
  group_archived: "Group archived",
  routing_failed: "The lead could not route this",
};

/** The reason a paused task shows in words; unknown reasons read as "Paused". */
export function assistantGroupPauseReasonLabel(reason: string | null): string {
  return (reason !== null ? PAUSE_REASON_LABEL[reason] : undefined) ?? "Paused";
}

/** Why a queued task is held back by a resource: "waiting for <resource> (used by <member>)". */
export function assistantGroupWaitingReason(
  task: Pick<AssistantGroupTask, "status" | "reason">,
): string | null {
  return task.status === "queued" && task.reason?.startsWith("waiting for ") ? task.reason : null;
}

/**
 * A request that opened no task and got no note yet: the lead is still choosing who answers it, or
 * the group has no lead and the message waits for one.
 */
export function assistantGroupAwaitingRoute(
  state: AssistantGroupChatState,
  message: AssistantGroupMessage,
): boolean {
  if (message.kind !== "message" || message.author === "assistant") return false;
  for (const task of state.tasks.values()) if (task.requestMessageId === message.id) return false;
  for (const other of state.messages.values()) {
    if (
      other.replyToMessageId === message.id &&
      (other.kind === "notice" || other.kind === "change" || other.kind === "routing")
    )
      return false;
  }
  return true;
}

/** Who wrote a message, as an answer names it: "you", the member, or the agent or schedule. */
export function assistantGroupAuthorName(
  message: Pick<AssistantGroupMessage, "author" | "assistantId" | "authorLabel">,
  memberName: (assistantId: string) => string | undefined,
): string {
  switch (message.author) {
    case "user":
      return "you";
    case "assistant":
      return (
        (message.assistantId === null ? undefined : memberName(message.assistantId)) ?? "a member"
      );
    case "agent":
      return message.authorLabel ?? "an agent";
    case "routine":
      return message.authorLabel ?? "a schedule";
  }
}

/** A message the user did not write and that is worth reading (routing notes are chatter). */
function countsAsUnread(message: Pick<AssistantGroupMessage, "author" | "kind">): boolean {
  return (
    message.author !== "user" &&
    message.kind !== "routing" &&
    message.kind !== "boundary" &&
    message.kind !== "change"
  );
}

/** The newest loaded message number, 0 for an empty chat. */
export function assistantGroupLatestSeq(state: AssistantGroupChatState): number {
  let latest = 0;
  for (const message of state.messages.values()) latest = Math.max(latest, message.seq);
  return latest;
}

/** Where the "New" line goes: the first message past the read position that others wrote. */
export function assistantGroupNewSeq(
  state: AssistantGroupChatState,
  readSeq: number,
): number | null {
  let first: number | null = null;
  for (const message of state.messages.values()) {
    if (message.seq > readSeq && countsAsUnread(message) && (first === null || message.seq < first))
      first = message.seq;
  }
  return first;
}

/**
 * What an open chat reports as read. `seen` is the furthest it has been read while open, by the
 * server's position or a report already sent, so marking it unread from the menu lowers the
 * server's position without making the chat report it read again until something newer arrives.
 */
export function assistantGroupReadStep(input: {
  readonly latestSeq: number | null;
  readonly readSeq: number;
  readonly seen: number;
}): { readonly seen: number; readonly target: number | null } {
  const seen = Math.max(input.seen, input.readSeq);
  const { latestSeq } = input;
  return {
    seen,
    target: latestSeq !== null && latestSeq > input.readSeq && latestSeq > seen ? latestSeq : null,
  };
}

type TeamChat = Pick<AssistantTeam, "name"> & {
  readonly chat?: AssistantTeam["chat"];
  readonly archivedAt?: AssistantTeam["archivedAt"];
};

/** A group whose tasks went from open to none: the work of a request is done. */
export function assistantGroupFinished(
  previous: TeamChat | undefined,
  next: TeamChat,
): { readonly title: string; readonly body: string } | null {
  // Archiving a busy group pauses its tasks; that is not a request finishing.
  if (next.archivedAt != null) return null;
  if (previous?.chat?.working !== true || next.chat === undefined || next.chat.working) return null;
  const preview = next.chat.preview?.replace(/\s+/g, " ").trim() ?? "";
  return {
    title: `${next.name} finished`,
    body: preview.length > 140 ? `${preview.slice(0, 139)}…` : preview,
  };
}

/** "N running" count for the header: tasks being worked right now. */
export function assistantGroupRunningCount(state: AssistantGroupChatState): number {
  let count = 0;
  for (const task of state.tasks.values()) if (task.status === "running") count += 1;
  return count;
}

/** The divider's wording, for a boundary message's `new` or `compact` text. */
export function assistantGroupBoundaryLabel(message: Pick<AssistantGroupMessage, "text">): string {
  return message.text === "compact" ? "Context compacted" : "New conversation started";
}
