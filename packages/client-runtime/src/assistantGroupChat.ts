import {
  ASSISTANT_GROUP_EVERYONE,
  ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION,
  ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY,
  assistantGroupAddress,
  assistantGroupMentions,
  assistantGroupProjectMentionRanges,
  assistantGroupProjectSlug,
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
  type ProjectId,
} from "@t3tools/contracts";

export interface AssistantGroupChatState {
  readonly messages: ReadonlyMap<AssistantGroupMessageId, AssistantGroupMessage>;
  readonly tasks: ReadonlyMap<AssistantGroupTaskId, AssistantGroupTask>;
  /** Older messages exist than the ones loaded. */
  readonly hasMore: boolean;
  /**
   * First messages of loaded requests that lie before the loaded page. Kept apart so they name
   * their request's block without counting as loaded history.
   */
  readonly requests: ReadonlyMap<AssistantGroupMessageId, AssistantGroupMessage>;
}

const byId = (messages: ReadonlyArray<AssistantGroupMessage> | undefined) =>
  new Map((messages ?? []).map((message) => [message.id, message]));

/** Folds one event; the first is always a snapshot, so state starts from it. */
export function applyAssistantGroupsEvent(
  state: AssistantGroupChatState | null,
  event: AssistantGroupsEvent,
): AssistantGroupChatState | null {
  if (event.type === "snapshot") {
    return {
      messages: byId(event.messages),
      tasks: new Map(event.tasks.map((task) => [task.id, task])),
      hasMore: event.hasMore,
      requests: byId(event.requests),
    };
  }
  if (state === null) return null;
  if (event.type === "message") {
    // A request's first message comes again when its project or title is set; one older than the
    // loaded page stays out of it, or paging would skip what lies between.
    const oldest = oldestAssistantGroupSeq(state);
    if (
      state.requests.has(event.message.id) ||
      (!state.messages.has(event.message.id) &&
        event.message.requestId === event.message.id &&
        oldest !== null &&
        event.message.seq < oldest)
    ) {
      return { ...state, requests: new Map(state.requests).set(event.message.id, event.message) };
    }
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
  const requests = new Map(state.requests);
  for (const id of messages.keys()) requests.delete(id);
  for (const request of page.requests ?? [])
    if (!messages.has(request.id) && !requests.has(request.id)) requests.set(request.id, request);
  return { messages, tasks, hasMore: page.hasMore, requests };
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

export type AssistantGroupRequestStatus =
  /** The lead is still choosing who answers. */
  | "routing"
  /** The lead asked which project the request is for. */
  | "needs-project"
  | "working"
  /** A task is paused or failed: the user resumes, reassigns or cancels it. */
  | "needs-you"
  | "done"
  | "cancelled";

export const ASSISTANT_GROUP_REQUEST_STATUS_LABEL: Record<AssistantGroupRequestStatus, string> = {
  routing: "Routing",
  "needs-project": "Needs project",
  working: "Working",
  "needs-you": "Needs you",
  done: "Done",
  cancelled: "Cancelled",
};

/** The composer's project choice when the user picks none. */
export const ASSISTANT_GROUP_LEAD_DECIDES_LABEL = "Lead decides";
/** The project filter's choice that shows every request. */
export const ASSISTANT_GROUP_ALL_PROJECTS_LABEL = "All projects";

export interface AssistantGroupRequestBlock {
  readonly requestId: AssistantGroupMessageId;
  /** The request's first message; null only while it is neither loaded nor sent along. */
  readonly root: AssistantGroupMessage | null;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly status: AssistantGroupRequestStatus;
  /** The loaded messages of the request, in seq order. */
  readonly rows: ReadonlyArray<AssistantGroupFeedRow>;
  readonly latestSeq: number;
}

export type AssistantGroupFeedItem =
  | { readonly kind: "request"; readonly block: AssistantGroupRequestBlock }
  /** A boundary, or a line that belongs to no request (a change to the group). */
  | { readonly kind: "row"; readonly row: AssistantGroupFeedRow };

/** First non-empty line with its leading mentions dropped, as the server titles a request. */
function titleOf(message: AssistantGroupMessage | null): string {
  if (message === null) return "Earlier request";
  if (message.title !== undefined && message.title !== "") return message.title;
  const line =
    message.text
      .split("\n")
      .map((part) => part.replace(/^(?:\s*@[\p{L}\p{N}_-]+[,:]?)+\s*/u, "").trim())
      .find((part) => part !== "") ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "Request";
}

const OPEN_STATUSES = new Set<AssistantGroupTaskStatus>(["queued", "running", "waiting"]);

function requestStatus(
  state: AssistantGroupChatState,
  root: AssistantGroupMessage | null,
  rows: ReadonlyArray<AssistantGroupFeedRow>,
  tasks: ReadonlyArray<AssistantGroupTask>,
): AssistantGroupRequestStatus {
  // A member's conversation waiting on the user outranks the work around it.
  if (rows.some((row) => row.message.waiting?.resolved === false)) return "needs-you";
  if (tasks.some((task) => OPEN_STATUSES.has(task.status))) return "working";
  if (tasks.some((task) => task.status === "paused" || task.status === "failed")) {
    return "needs-you";
  }
  if (tasks.length > 0) {
    return tasks.every((task) => task.status === "cancelled") ? "cancelled" : "done";
  }
  if (root === null) return "done";
  // The lead's question sits after the root as a notice, until a member is given the request.
  if (
    root.projectId === undefined &&
    rows.some(
      (row) =>
        row.message.kind === "notice" &&
        row.message.author === "assistant" &&
        row.message.waiting === undefined,
    )
  ) {
    return "needs-project";
  }
  return assistantGroupAwaitingRoute(state, root) ? "routing" : "done";
}

/**
 * The chat cut into its requests, each with its own messages and cards, ordered by the request's
 * latest message so the one being worked sits next to the composer. Boundaries and lines of no
 * request stay where they fall.
 */
export function assistantGroupRequestFeed(
  state: AssistantGroupChatState,
): ReadonlyArray<AssistantGroupFeedItem> {
  const groups = new Map<AssistantGroupMessageId, AssistantGroupFeedRow[]>();
  const loose: AssistantGroupFeedItem[] = [];
  for (const row of assistantGroupFeed(state)) {
    const requestId = row.message.requestId;
    if (requestId === undefined) {
      loose.push({ kind: "row", row });
      continue;
    }
    const rows = groups.get(requestId);
    if (rows === undefined) groups.set(requestId, [row]);
    else rows.push(row);
  }
  const blocks: AssistantGroupFeedItem[] = [...groups].map(([requestId, rows]) => {
    const root = state.messages.get(requestId) ?? state.requests.get(requestId) ?? null;
    const tasks = [...state.tasks.values()].filter(
      (task) =>
        (task.requestId ?? state.messages.get(task.requestMessageId)?.requestId) === requestId,
    );
    return {
      kind: "request",
      block: {
        requestId,
        root,
        projectId: root?.projectId ?? null,
        title: titleOf(root),
        status: requestStatus(state, root, rows, tasks),
        rows,
        latestSeq: rows.at(-1)!.message.seq,
      },
    };
  });
  const seqOf = (item: AssistantGroupFeedItem) =>
    item.kind === "request" ? item.block.latestSeq : item.row.message.seq;
  return [...blocks, ...loose].sort((a, b) => seqOf(a) - seqOf(b));
}

/** The projects the loaded requests run in, in first-seen order, for the filter. */
export function assistantGroupFeedProjects(
  items: ReadonlyArray<AssistantGroupFeedItem>,
): ReadonlyArray<ProjectId> {
  const seen = new Set<ProjectId>();
  for (const item of items)
    if (item.kind === "request" && item.block.projectId !== null) seen.add(item.block.projectId);
  return [...seen];
}

/**
 * The feed narrowed to one project's requests; null keeps everything. A request still waiting
 * for its project shows under every filter, so a new one never vanishes as it is sent.
 */
export function filterAssistantGroupFeed(
  items: ReadonlyArray<AssistantGroupFeedItem>,
  projectId: ProjectId | null,
): ReadonlyArray<AssistantGroupFeedItem> {
  if (projectId === null) return items;
  return items.filter(
    (item) =>
      item.kind === "request" &&
      (item.block.projectId === projectId ||
        (item.block.projectId === null &&
          (item.block.status === "routing" || item.block.status === "needs-project"))),
  );
}

/**
 * A block opens by itself while it needs attention, holds unread messages, or is the newest one;
 * finished requests fold away. The user's own toggle wins over this.
 */
export function assistantGroupRequestExpanded(
  block: AssistantGroupRequestBlock,
  readSeq: number,
  newest: boolean,
): boolean {
  if (newest || (block.status !== "done" && block.status !== "cancelled")) return true;
  return block.rows.some((row) => row.message.seq > readSeq && countsAsUnread(row.message));
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

// Spans a mention link must not enter: code, links (a link inside one would nest), autolinks, bare URLs.
const PROTECTED_SPAN = /(`+)[\s\S]*?\1|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|https?:\/\/\S+/g;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Scheme of the link a member mention becomes (`/<handle>` or `/everyone` follows); clients style it and never navigate. */
export const ASSISTANT_MENTION_HREF = "t3-mention:mention";

/** Scheme of the link a `#project` mention becomes (`/<slug>` follows); clients style it and never navigate. */
const ASSISTANT_PROJECT_HREF = "t3-mention:project";

/** The member handle (or `everyone`) or project slug a group mention link names. */
export function assistantGroupMentionHref(
  href: string,
): { readonly kind: "member" | "project"; readonly value: string } | null {
  for (const [kind, scheme] of [
    ["member", ASSISTANT_MENTION_HREF],
    ["project", ASSISTANT_PROJECT_HREF],
  ] as const) {
    if (href.startsWith(`${scheme}/`)) return { kind, value: href.slice(scheme.length + 1) };
  }
  return null;
}

const linkProjects = (
  text: string,
  projects: ReadonlyArray<{ readonly id: string; readonly name: string }>,
) => {
  let out = "";
  let at = 0;
  for (const found of assistantGroupProjectMentionRanges(text, projects)) {
    out += `${text.slice(at, found.start)}[${text.slice(found.start, found.end)}](${ASSISTANT_PROJECT_HREF}/${assistantGroupProjectSlug(found.project.name)})`;
    at = found.end;
  }
  return out + text.slice(at);
};

/**
 * Markdown with each member `@mention` and group `#project` made a mention link, except in code
 * spans and fenced blocks.
 */
export function assistantGroupMarkdownMentions(
  markdown: string,
  members: ReadonlyArray<Pick<Assistant, "handle" | "name">>,
  projects: ReadonlyArray<{ readonly id: string; readonly name: string }> = [],
): string {
  if (!markdown.includes("@") && (projects.length === 0 || !markdown.includes("#"))) {
    return markdown;
  }
  const link = (text: string) => {
    let out = "";
    let at = 0;
    for (const found of assistantGroupMentions(text, members)) {
      const handle = found.member === null ? "everyone" : found.member.handle.toLowerCase();
      out += `${linkProjects(text.slice(at, found.start), projects)}[${text.slice(found.start, found.end)}](${ASSISTANT_MENTION_HREF}/${handle})`;
      at = found.end;
    }
    return out + linkProjects(text.slice(at), projects);
  };
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

const PROJECT_BEING_TYPED = /(?:^|[\s(])#([\p{L}\p{N}_./-]*)$/u;

/** The `#word` the caret is in, where a project mention could start. */
export function assistantGroupProjectQuery(
  text: string,
  caret: number,
): AssistantGroupMentionQuery | null {
  const match = PROJECT_BEING_TYPED.exec(text.slice(0, caret));
  if (match === null) return null;
  return {
    start: caret - match[1]!.length - 1,
    end: caret,
    query: foldAssistantGroupText(match[1]!),
  };
}

/** The group's projects whose `#slug` or name starts with the query, in the group's order. */
export function assistantGroupProjectOptions<
  P extends { readonly id: string; readonly name: string },
>(query: string, projects: ReadonlyArray<P>): ReadonlyArray<P> {
  return projects.filter(
    (project) =>
      assistantGroupProjectSlug(project.name).startsWith(query) ||
      foldAssistantGroupText(project.name).startsWith(query),
  );
}

/** One plain-text line of a markdown message, for a reply quote. */
export function assistantGroupMessageExcerpt(text: string): string {
  return text
    .replace(/^\s*(?:```|~~~).*$/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text with the `#word` replaced by the project's `#slug` and a space, and where the caret goes. */
export function insertAssistantGroupProject(
  text: string,
  mention: AssistantGroupMentionQuery,
  project: { readonly name: string },
): { readonly text: string; readonly caret: number } {
  const inserted = `#${assistantGroupProjectSlug(project.name)} `;
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
