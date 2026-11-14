import {
  ASSISTANT_GROUP_EVERYONE,
  ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION,
  ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY,
  ASSISTANT_GROUP_WORKING_TASK_STATUSES,
  assistantGroupCountsAsUnread,
  assistantGroupFinishedScopes,
  assistantGroupTasksNeedUser,
  assistantGroupAddress,
  assistantGroupInstructionBody,
  assistantGroupMentions,
  assistantGroupProjectIds,
  assistantGroupProjectMentionRanges,
  assistantGroupProjectSlugs,
  foldAssistantGroupText,
  type Assistant,
  type AssistantTeam,
  type AssistantTeamChat,
  type AssistantTeamChatScope,
  type AssistantGroupMessage,
  type AssistantGroupScope,
  type AssistantGroupMessageId,
  type AssistantGroupTask,
  type AssistantGroupTaskId,
  type AssistantGroupTaskStatus,
  type AssistantGroupsEvent,
  type AssistantGroupsHistoryResult,
  type ProjectId,
} from "@t3tools/contracts";
import type { TaskEventStatus } from "@t3tools/shared/assistantTaskEvents";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { projectNoticePrefix } from "@t3tools/shared/projectNotice";
import { TASK_EVENT_STATUS_LABEL } from "./assistantTasks.ts";

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

// A usage-limited task continues at its reset, so its request is still being worked.
const OPEN_STATUSES: ReadonlySet<AssistantGroupTaskStatus> = new Set(
  ASSISTANT_GROUP_WORKING_TASK_STATUSES,
);

function requestStatus(
  state: AssistantGroupChatState,
  root: AssistantGroupMessage | null,
  rows: ReadonlyArray<AssistantGroupFeedRow>,
  tasks: ReadonlyArray<AssistantGroupTask>,
): AssistantGroupRequestStatus {
  // A member's conversation waiting on the user outranks the work around it.
  if (rows.some((row) => row.message.waiting?.resolved === false)) return "needs-you";
  if (tasks.some((task) => OPEN_STATUSES.has(task.status))) return "working";
  if (assistantGroupTasksNeedUser(tasks.map((task) => task.status))) return "needs-you";
  if (tasks.length > 0) {
    return tasks.every((task) => task.status === "cancelled") ? "cancelled" : "done";
  }
  if (root === null) return "done";
  if (root.projectId === undefined && rows.some((row) => row.message.asksProject === true)) {
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

/** The project a request runs in, from its root on the page or off it. */
export function assistantGroupRequestProject(
  state: AssistantGroupChatState,
  requestId: AssistantGroupMessageId | undefined,
): ProjectId | null {
  if (requestId === undefined) return null;
  return (state.messages.get(requestId) ?? state.requests.get(requestId))?.projectId ?? null;
}

export type AssistantGroupTabKey = "all" | "general" | `project:${string}`;

/** The tab of a project's requests; General for those with none. */
function assistantGroupTabKey(projectId: ProjectId | null): AssistantGroupTabKey {
  return projectId === null ? "general" : `project:${projectId}`;
}

export interface AssistantGroupTab {
  readonly key: AssistantGroupTabKey;
  /** undefined for All (unscoped reads); { projectId: null } for General. */
  readonly scope: AssistantGroupScope | undefined;
  /** Project title; "All", "General", or "Removed project" for an orphan scope. */
  readonly label: string;
  /** The project, for its favicon; null for All and General. */
  readonly projectId: ProjectId | null;
  readonly unreadCount: number;
  readonly waiting: boolean;
  /** Where the tab's "New" line and read marker start: the tab's own position, else the group's. */
  readonly readSeq: number;
}

/**
 * A project's name anywhere in a group chat: its title, else the one the chat last knew. One
 * still in the group (`groupProjectIds`) whose title has not loaded reads "Unknown project"; one
 * that left, known by neither, reads "Removed project", numbered by scope order when several are.
 */
export function assistantGroupProjectLabel(
  projectId: ProjectId,
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>,
  scopes: ReadonlyArray<Pick<AssistantTeamChatScope, "projectId" | "title">> | undefined,
  groupProjectIds: ReadonlyArray<ProjectId>,
): string {
  const known = (id: ProjectId | null) =>
    projects.find((project) => project.id === id)?.title ??
    scopes?.find((scope) => scope.projectId === id)?.title;
  const title = known(projectId);
  if (title !== undefined) return title;
  if (groupProjectIds.includes(projectId)) return "Unknown project";
  const nameless = (scopes ?? []).filter(
    (scope) =>
      scope.projectId !== null &&
      !groupProjectIds.includes(scope.projectId) &&
      known(scope.projectId) === undefined,
  );
  const index = nameless.findIndex((scope) => scope.projectId === projectId);
  return index < 1 ? "Removed project" : `Removed project ${index + 1}`;
}

/** The user's project pick in the composer, for the tab it was made in. */
export interface AssistantGroupProjectPick {
  readonly tab: AssistantGroupTabKey | null;
  readonly projectId: ProjectId | null;
}

/**
 * The project a new request gets: the pick made in the open tab, else that tab's project, but
 * none while replying, since a reply keeps its request's. Only a group project counts; null
 * lets the lead decide.
 */
export function assistantGroupComposerProject(input: {
  readonly pick: AssistantGroupProjectPick | null;
  readonly tab: Pick<AssistantGroupTab, "key" | "projectId"> | null;
  readonly replying: boolean;
  readonly groupProjects: ReadonlyArray<{ readonly id: ProjectId }>;
}): ProjectId | null {
  const chosen =
    input.pick !== null && input.pick.tab === (input.tab?.key ?? null)
      ? input.pick.projectId
      : input.replying
        ? null
        : (input.tab?.projectId ?? null);
  return input.groupProjects.some((project) => project.id === chosen) ? chosen : null;
}

/** Any tab waits on the user: the dot on All and on the group's row. */
export function assistantGroupChatWaiting(chat: Pick<AssistantTeamChat, "scopes"> | undefined) {
  return chat?.scopes?.some((scope) => scope.waiting) ?? false;
}

/**
 * null (no tab row) when the server sent no scopes or the group has fewer than 2 effective
 * projects. Else All, the effective projects, orphan scopes that still have unread or waiting,
 * then General when the chat lists it. The `active` tab stays listed even once its project left
 * the group, so the one being read never vanishes.
 */
export function assistantGroupTabs(input: {
  readonly team: Pick<AssistantTeam, "projectIds" | "chat">;
  readonly members: ReadonlyArray<Pick<Assistant, "projectId" | "projectIds">>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly active?: string | null | undefined;
}): ReadonlyArray<AssistantGroupTab> | null {
  const chat = input.team.chat;
  if (chat?.scopes === undefined) return null;
  const title = new Map(input.projects.map((project) => [project.id, project.title]));
  const groupIds = assistantGroupProjectIds(input.members, input.team.projectIds);
  const effective = groupIds.filter((id) => title.has(id));
  const scopes = chat.scopes;
  // A project neither loaded nor listed is a stale key, not a tab being read.
  const keptProject =
    [...title.keys(), ...scopes.map((scope) => scope.projectId)].find(
      (id) => id !== null && input.active === `project:${id}`,
    ) ?? null;
  const keptGeneral = input.active === "general";
  if (effective.length < 2 && keptProject === null && !keptGeneral) return null;
  const tab = (projectId: ProjectId | null, label: string): AssistantGroupTab => {
    const found = scopes.find((scope) => scope.projectId === projectId);
    return {
      key: assistantGroupTabKey(projectId),
      scope: { projectId },
      label,
      projectId,
      unreadCount: found?.unreadCount ?? 0,
      waiting: found?.waiting ?? false,
      readSeq: found?.readSeq ?? chat.readSeq,
    };
  };
  const orphans = scopes.flatMap((scope) =>
    scope.projectId !== null &&
    !effective.includes(scope.projectId) &&
    (scope.unreadCount > 0 || scope.waiting || scope.projectId === keptProject)
      ? [scope.projectId]
      : [],
  );
  if (keptProject !== null && !effective.includes(keptProject) && !orphans.includes(keptProject)) {
    orphans.push(keptProject);
  }
  return [
    {
      key: "all",
      scope: undefined,
      label: "All",
      projectId: null,
      unreadCount: chat.unreadCount,
      waiting: assistantGroupChatWaiting(chat),
      readSeq: chat.readSeq,
    },
    ...effective.map((id) => tab(id, title.get(id)!)),
    ...orphans.map((id) =>
      tab(id, assistantGroupProjectLabel(id, input.projects, scopes, groupIds)),
    ),
    ...(keptGeneral || scopes.some((scope) => scope.projectId === null)
      ? [tab(null, "General")]
      : []),
  ];
}

/**
 * True while a tab-less view may only be data still loading: the server sent scopes, yet a member
 * is not in the assistant list, or no project has arrived while the group names two or more. A
 * member's deleted home project stays listed but projects are loaded, so that group is not pending.
 */
export function assistantGroupTabsPending(input: {
  readonly team: Pick<AssistantTeam, "projectIds" | "memberIds" | "chat">;
  readonly members: ReadonlyArray<Pick<Assistant, "projectId" | "projectIds">>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
  /** Every assistant the client has loaded for the environment, archived included. */
  readonly assistants: { readonly has: (id: string) => boolean };
}): boolean {
  if (input.team.chat?.scopes === undefined) return false;
  if (input.team.memberIds.some((id) => !input.assistants.has(id))) return true;
  return (
    input.projects.length === 0 &&
    assistantGroupProjectIds(input.members, input.team.projectIds).length >= 2
  );
}

/**
 * The tabs to show and the open one; while members, projects or the saved tab load, pending and
 * none. A server without scopes has no tabs, so it never waits for the saved one.
 */
export function assistantGroupTabView(input: {
  readonly team: Pick<AssistantTeam, "projectIds" | "memberIds" | "chat"> | undefined;
  readonly members: ReadonlyArray<Pick<Assistant, "projectId" | "projectIds">>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly assistants: { readonly has: (id: string) => boolean };
  readonly saved: string | null | undefined;
  /** The saved tab is still being read. */
  readonly loading?: boolean;
}): {
  readonly pending: boolean;
  readonly tabs: ReadonlyArray<AssistantGroupTab> | null;
  readonly tab: AssistantGroupTab | null;
  /** What the chat reads: the tab's scope, undefined for every request, null for nothing yet. */
  readonly scope: AssistantGroupScope | undefined | null;
} {
  const { team } = input;
  if (team === undefined) return { pending: false, tabs: null, tab: null, scope: null };
  const known = { ...input, team };
  // Decided before keeping the saved tab: a project still loading would otherwise show as removed.
  if (
    (input.loading === true && team.chat?.scopes !== undefined) ||
    (assistantGroupTabs(known) === null && assistantGroupTabsPending(known))
  ) {
    return { pending: true, tabs: null, tab: null, scope: null };
  }
  const tabs = assistantGroupTabs({ ...known, active: input.saved });
  const tab = tabs === null ? null : resolveAssistantGroupTab(input.saved, tabs);
  return { pending: false, tabs, tab, scope: tab?.scope };
}

/** The saved key's tab, else All. */
export function resolveAssistantGroupTab(
  saved: string | null | undefined,
  tabs: ReadonlyArray<AssistantGroupTab>,
): AssistantGroupTab {
  return tabs.find((tab) => tab.key === saved) ?? tabs[0]!;
}

/**
 * After a send from tab `sent` lands in `landed`, the tab that still shows it, or null to stay on
 * the open one (`saved`, read when the send settles): a user who left `sent` meanwhile stays where
 * they went. One with no project yet may still get one from the lead: only All is sure to hold it.
 */
export function assistantGroupTabAfterSend(
  tabs: ReadonlyArray<AssistantGroupTab>,
  sent: AssistantGroupTabKey,
  saved: string | null | undefined,
  landed: ProjectId | null,
): AssistantGroupTabKey | null {
  const open = resolveAssistantGroupTab(saved, tabs);
  if (open.key === "all" || open.key !== sent) return null;
  const target = tabs.find((entry) => entry.scope?.projectId === landed);
  if (target?.key === open.key) return null;
  return landed === null ? "all" : (target?.key ?? "all");
}

/** False for a request whose project no longer matches the scope. */
export function assistantGroupInScope(
  block: Pick<AssistantGroupRequestBlock, "projectId">,
  scope: AssistantGroupScope | undefined,
): boolean {
  return scope === undefined || block.projectId === scope.projectId;
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
  const lastUserSeq = lastUserSeqs(block.rows.map((row) => row.message)).get(block.requestId);
  return block.rows.some(
    (row) => row.message.seq > readSeq && assistantGroupCountsAsUnread(row.message, lastUserSeq),
  );
}

/** Each request's newest line by the user among `messages`: what answers the lines before it. */
function lastUserSeqs(messages: Iterable<AssistantGroupMessage>): Map<string, number> {
  const latest = new Map<string, number>();
  for (const message of messages) {
    if (message.author !== "user" || message.requestId === undefined) continue;
    latest.set(message.requestId, Math.max(latest.get(message.requestId) ?? 0, message.seq));
  }
  return latest;
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

type MentionProject = { readonly id: string; readonly name: string };

/** Each project's `#slug`, in order: the one place clients name a group project. */
const projectSlugs = (projects: ReadonlyArray<MentionProject>) => {
  const slugs = assistantGroupProjectSlugs(projects);
  return projects.map((project) => slugs.get(project.id)!);
};

/** The `@handle`s and `#slug`s the composer draws as a group's own chips. */
export function assistantGroupMentionTargets(
  members: ReadonlyArray<Pick<Assistant, "handle">>,
  projects: ReadonlyArray<MentionProject>,
): { readonly memberHandles: ReadonlyArray<string>; readonly projectSlugs: ReadonlyArray<string> } {
  return {
    memberHandles: [
      ...members.map((member) => foldAssistantGroupText(member.handle)),
      ASSISTANT_GROUP_EVERYONE,
    ],
    projectSlugs: projectSlugs(projects),
  };
}

export type AssistantGroupMentionTarget<M, P> =
  /** `member` is null for `@everyone`. */
  | { readonly kind: "member"; readonly member: M | null }
  | { readonly kind: "project"; readonly project: P };

/**
 * The member or project a chip's value (after `@` or `#`) names, as the server reads it: a
 * member by handle or name, a project by its `#slug`, case and accents ignored.
 */
export function assistantGroupMentionTarget<
  M extends Pick<Assistant, "handle" | "name">,
  P extends MentionProject,
>(
  kind: "member" | "project",
  value: string,
  members: ReadonlyArray<M>,
  projects: ReadonlyArray<P>,
): AssistantGroupMentionTarget<M, P> | null {
  if (kind === "project") {
    const project = projects[projectSlugs(projects).indexOf(foldAssistantGroupText(value))];
    return project === undefined ? null : { kind, project };
  }
  const [found] = assistantGroupMentions(`@${value}`, members);
  return found?.start === 0 && found.end === value.length + 1
    ? { kind, member: found.member }
    : null;
}

const linkProjects = (text: string, projects: ReadonlyArray<MentionProject>) => {
  if (!text.includes("#")) return text;
  const slugs = projectSlugs(projects);
  let out = "";
  let at = 0;
  for (const found of assistantGroupProjectMentionRanges(text, projects)) {
    out += `${text.slice(at, found.start)}[${text.slice(found.start, found.end)}](${ASSISTANT_PROJECT_HREF}/${slugs[projects.indexOf(found.project)]})`;
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
>(query: string, projects: ReadonlyArray<P>): ReadonlyArray<P & { readonly slug: string }> {
  const slugs = projectSlugs(projects);
  return projects
    .map((project, index) => ({ ...project, slug: slugs[index]! }))
    .filter(
      (project) =>
        project.slug.startsWith(query) || foldAssistantGroupText(project.name).startsWith(query),
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
  project: { readonly slug: string },
): { readonly text: string; readonly caret: number } {
  const inserted = `#${project.slug} `;
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
  usage_limited: "Usage limit",
  completed: "Completed",
  paused: "Paused",
  cancelled: "Cancelled",
  failed: "Failed",
};

const ACTIVITY_STATUS: Partial<
  Record<AssistantGroupTaskStatus | AssistantGroupRequestStatus, TaskEventStatus>
> = {
  completed: "completed",
  done: "completed",
  failed: "failed",
  cancelled: "cancelled",
  paused: "interrupted",
  "needs-you": "interrupted",
};

const ACTIVITY_LABEL: Record<AssistantGroupTaskStatus | AssistantGroupRequestStatus, string> = {
  ...ASSISTANT_GROUP_REQUEST_STATUS_LABEL,
  ...ASSISTANT_GROUP_STATUS_LABEL,
};

/**
 * A task or request as the thread's task activity line shows it. The title is the member thread's,
 * else the instruction's gist without its routing line; empty with neither.
 */
export function assistantGroupActivity(
  status: AssistantGroupTaskStatus | AssistantGroupRequestStatus,
  source: { readonly threadTitle?: string | null | undefined; readonly instruction?: string } = {},
): { readonly title: string; readonly status: TaskEventStatus | null; readonly label: string } {
  const eventStatus = ACTIVITY_STATUS[status] ?? null;
  return {
    title:
      source.threadTitle?.trim() ||
      assistantGroupMessageExcerpt(assistantGroupInstructionBody(source.instruction ?? "")),
    status: eventStatus,
    // The thread's word for an ending; the thread has none for paused or waiting on the user.
    label:
      eventStatus === null || eventStatus === "interrupted"
        ? ACTIVITY_LABEL[status]
        : TASK_EVENT_STATUS_LABEL[eventStatus],
  };
}

/** An answer's Worked fold label, as the thread words a finished turn. */
export function assistantGroupWorkedLabel(
  message: Pick<AssistantGroupMessage, "workedMs">,
): string {
  return message.workedMs === undefined
    ? "Worked"
    : `Worked for ${formatDuration(message.workedMs)}`;
}

/**
 * Where an answer's relative file links resolve: its task thread's worktree, else that thread's
 * project; the request's project only when there is no thread (or its shell is not loaded yet).
 */
export function assistantGroupAnswerRoot(input: {
  readonly thread: {
    readonly worktreePath: string | null;
    readonly projectRoot: string | null | undefined;
  } | null;
  readonly requestRoot: string | null | undefined;
}): string | null {
  if (input.thread === null) return input.requestRoot ?? null;
  return input.thread.worktreePath ?? input.thread.projectRoot ?? null;
}

const PAUSE_REASON_LABEL: Record<string, string> = {
  stopped: "Stopped",
  no_delivery: `${ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY} hand-offs without a delivery`,
  handoff_limit: `${ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION} hand-offs since your last action`,
  member_removed: "Owner left the group",
  group_archived: "Group archived",
  routing_failed: "The lead could not route this",
};

const FAILURE_REASON_LABEL: Record<string, string> = {
  outside_project: "Owner cannot work in this request's project",
  thread_unavailable: "Could not open the owner's conversation",
  request_missing: "The request is gone",
  could_not_start: "Could not start the owner's turn",
};

/** A cancellation the server made; one a member made carries its own words, shown elsewhere. */
const CANCEL_REASON_LABEL: Record<string, string> = {
  outside_project: "Owner no longer works in this request's project",
};

/**
 * Why a paused, failed or cancelled task stopped, in words: an unknown pause reads as "Paused", an
 * unknown failure or cancellation as nothing (the status already says it).
 */
export function assistantGroupTaskReasonLabel(
  task: Pick<AssistantGroupTask, "status" | "reason">,
): string | null {
  const known = task.reason === null ? undefined : task.reason;
  if (task.status === "paused") return (known && PAUSE_REASON_LABEL[known]) || "Paused";
  if (task.status === "failed") return (known && FAILURE_REASON_LABEL[known]) || null;
  if (task.status === "cancelled") return (known && CANCEL_REASON_LABEL[known]) || null;
  return null;
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

/** The newest loaded message number, 0 for an empty chat. */
export function assistantGroupLatestSeq(state: AssistantGroupChatState): number {
  let latest = 0;
  for (const message of state.messages.values()) latest = Math.max(latest, message.seq);
  return latest;
}

/**
 * Where the "New" line goes: the first message past the read position that others wrote. All
 * passes `assistantGroupAllReadSeq`, so a message read in its tab is not new there.
 */
export function assistantGroupNewSeq(
  state: AssistantGroupChatState,
  readSeq: number | ((message: AssistantGroupMessage) => number),
): number | null {
  let first: number | null = null;
  const answered = lastUserSeqs(state.messages.values());
  for (const message of state.messages.values()) {
    const position = typeof readSeq === "number" ? readSeq : readSeq(message);
    if (
      message.seq > position &&
      assistantGroupCountsAsUnread(
        message,
        message.requestId === undefined ? undefined : answered.get(message.requestId),
      ) &&
      (first === null || message.seq < first)
    )
      first = message.seq;
  }
  return first;
}

/** A message's read position as the server counts it: its request's tab, else the group's. */
export function assistantGroupAllReadSeq(
  state: AssistantGroupChatState,
  chat: Pick<AssistantTeamChat, "readSeq" | "scopes">,
): (message: AssistantGroupMessage) => number {
  return (message) => {
    if (message.requestId === undefined) return chat.readSeq;
    const projectId = assistantGroupRequestProject(state, message.requestId);
    return chat.scopes?.find((scope) => scope.projectId === projectId)?.readSeq ?? chat.readSeq;
  };
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

export interface AssistantGroupFinishedNotice {
  readonly title: string;
  readonly body: string;
  /** The finished tab's project; null for General or an older server's unknown one. */
  readonly projectId: ProjectId | null;
  /** The tab that shows the work: All when an older server cannot say. */
  readonly tab: AssistantGroupTabKey;
}

/**
 * One notice per tab whose work just ended (`assistantGroupFinishedScopes`). The body is the
 * group's latest line when it comes from that tab, else a plain "Work finished", led by the
 * project in brackets like chat-app notices. An older server only says the whole group went
 * idle: one notice on the preview's project.
 */
export function assistantGroupFinished(
  previous: TeamChat | undefined,
  next: TeamChat,
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>,
): ReadonlyArray<AssistantGroupFinishedNotice> {
  // Archiving a busy group pauses its tasks; that is not a request finishing.
  if (next.archivedAt != null || next.chat === undefined) return [];
  const perTab = previous?.chat?.scopes?.some((scope) => (scope.openTasks ?? 0) > 0) ?? false;
  const legacy = !perTab && previous?.chat?.working === true && !next.chat.working;
  const finished = perTab
    ? assistantGroupFinishedScopes(previous?.chat, next.chat)
    : legacy
      ? [next.chat.previewProjectId ?? null]
      : [];
  const preview = next.chat.preview?.replace(/\s+/g, " ").trim() ?? "";
  const excerpt = preview.length > 140 ? `${preview.slice(0, 139)}…` : preview;
  return finished.map((projectId) => {
    const fromTab = legacy || (next.chat?.previewProjectId ?? null) === projectId;
    const body = fromTab && excerpt !== "" ? excerpt : legacy ? "" : "Work finished";
    const project = projects.find((candidate) => candidate.id === projectId);
    return {
      title: `${next.name} finished`,
      body: project === undefined || body === "" ? body : projectNoticePrefix(project.title, body),
      projectId,
      tab: legacy && projectId === null ? "all" : assistantGroupTabKey(projectId),
    };
  });
}

/**
 * The user already sees a finished tab's work in its open chat: on All (or with no tab row), or
 * on that tab. Any other tab hides it, so it still deserves a notice.
 */
export function assistantGroupFinishedInView(
  open: AssistantGroupTabKey | null,
  finished: AssistantGroupTabKey,
): boolean {
  return open === null || open === "all" || open === finished;
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
