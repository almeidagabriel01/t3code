import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { type Assistant, AssistantId, AssistantTeamId } from "./assistants.ts";
import { ChatAttachment, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";
import { DecisionId } from "./decisions.ts";

/**
 * A group's shared chat, as in an OpenBot channel. A message there runs no agent itself: it opens
 * one task per recipient. A message that replies to nothing starts a request; replies continue it.
 * Each member works a request in its own hidden thread for that request, in the request's project.
 */
/** The line the server puts before the links to files copied for an assistant. */
export const ASSISTANT_TRANSFER_HEADING = "Files copied to the shared folder for you:";

/** A message's own text, and the markdown list of files copied with it (null when none). */
export function splitAssistantTransferText(text: string): {
  readonly body: string;
  readonly files: string | null;
} {
  const marker = `\n${ASSISTANT_TRANSFER_HEADING}\n`;
  const at = text.lastIndexOf(marker);
  if (at < 0) return { body: text, files: null };
  return { body: text.slice(0, at).trimEnd(), files: text.slice(at + marker.length) };
}

export const ASSISTANT_GROUP_PARALLEL_LIMIT = 2;
/**
 * Hand-offs a request may make while none of its tasks delivers a new, non-empty answer: stops
 * members passing work around. Longest real stretch measured is 10 (five makers each asking for a
 * review); each extra maker adds two. Scenarios: AssistantGroups.test.ts.
 */
export const ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY = 12;
/**
 * Hand-offs since the user last acted on the request (Resume, Reassign, "continue", a message to its
 * members), deliveries or not: the backstop for a loop that keeps delivering. Longest real request
 * measured is 25 (five bugs, three review rounds each); 30 leaves room for one more such item.
 */
export const ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION = 30;
/** Member-to-member replies per request, whoever writes them. */
export const ASSISTANT_GROUP_REPLY_LIMIT = 2;
export const ASSISTANT_GROUP_REPLY_MAX_CHARS = 2_000;
export const ASSISTANT_GROUP_MESSAGE_MAX_CHARS = 20_000;
export const ASSISTANT_GROUP_PAGE_SIZE = 50;

export const AssistantGroupMessageId = TrimmedNonEmptyString.pipe(
  Schema.brand("AssistantGroupMessageId"),
);
export type AssistantGroupMessageId = typeof AssistantGroupMessageId.Type;

export const AssistantGroupTaskId = TrimmedNonEmptyString.pipe(
  Schema.brand("AssistantGroupTaskId"),
);
export type AssistantGroupTaskId = typeof AssistantGroupTaskId.Type;

/** Who wrote a message: the user, a member, an agent from another conversation, or a schedule. */
export const AssistantGroupAuthor = Schema.Literals(["user", "assistant", "agent", "routine"]);
export type AssistantGroupAuthor = typeof AssistantGroupAuthor.Type;

/**
 * `routing` is the lead naming who answers; `notice` is a status line such as a paused task;
 * `boundary` starts a new conversation (its text is `new` or `compact`): members see only what
 * comes after the latest one; `change` records an agent changing the group (a rename, a new
 * member): shown muted, never unread, and not part of what members are sent.
 */
export const AssistantGroupMessageKind = Schema.Literals([
  "message",
  "routing",
  "notice",
  "boundary",
  "change",
]);
export type AssistantGroupMessageKind = typeof AssistantGroupMessageKind.Type;

export const AssistantGroupWaiting = Schema.Struct({
  /** The member's conversation for the request; it holds the approval or question. */
  threadId: ThreadId,
  /** The open decision it asked through t3_decision, when that is what waits. */
  decisionId: Schema.optionalKey(DecisionId),
  resolved: Schema.Boolean,
});
export type AssistantGroupWaiting = typeof AssistantGroupWaiting.Type;

export const AssistantGroupMessage = Schema.Struct({
  id: AssistantGroupMessageId,
  teamId: AssistantTeamId,
  /** Per group, from 1; history pages by it. */
  seq: Schema.Int,
  author: AssistantGroupAuthor,
  /** The member for `assistant`, or the sending assistant for `agent` when it is one. */
  assistantId: Schema.NullOr(AssistantId),
  /** The agent conversation's title or the schedule's title; null for the user and members. */
  authorLabel: Schema.NullOr(Schema.String),
  kind: AssistantGroupMessageKind,
  text: Schema.String,
  replyToMessageId: Schema.NullOr(AssistantGroupMessageId),
  /** The task a member's message answers. */
  taskId: Schema.NullOr(AssistantGroupTaskId),
  /** Files and images sent with the message; absent from older servers and when there are none. */
  attachments: Schema.optionalKey(Schema.Array(ChatAttachment)),
  /** The request it belongs to (its first message); absent for chat-wide lines and older servers. */
  requestId: Schema.optionalKey(AssistantGroupMessageId),
  /** On a request's first message: where its work runs, once picked or inferred by the lead. */
  projectId: Schema.optionalKey(ProjectId),
  /** On a request's first message: its short title. */
  title: Schema.optionalKey(Schema.String),
  /**
   * On a notice that a member's conversation for the request waits on the user (an approval, a
   * question, an open decision): where to answer it, and whether it was answered since.
   */
  waiting: Schema.optionalKey(AssistantGroupWaiting),
  /** On the lead's notice asking which project a request is for; absent on every other message. */
  asksProject: Schema.optionalKey(Schema.Literal(true)),
  createdAt: IsoDateTime,
});
export type AssistantGroupMessage = typeof AssistantGroupMessage.Type;

export const AssistantGroupTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "paused",
  "cancelled",
  "failed",
]);
export type AssistantGroupTaskStatus = typeof AssistantGroupTaskStatus.Type;

/** `child` is an assignment from another member; `reply` is one short answer to a member. */
export const AssistantGroupTaskKind = Schema.Literals(["root", "child", "reply"]);
export type AssistantGroupTaskKind = typeof AssistantGroupTaskKind.Type;

export const AssistantGroupTask = Schema.Struct({
  id: AssistantGroupTaskId,
  teamId: AssistantTeamId,
  rootId: AssistantGroupTaskId,
  parentId: Schema.NullOr(AssistantGroupTaskId),
  kind: AssistantGroupTaskKind,
  requestMessageId: AssistantGroupMessageId,
  ownerId: AssistantId,
  instruction: Schema.String,
  status: AssistantGroupTaskStatus,
  /** Why it paused: stopped, no_delivery, handoff_limit, member_removed, group_archived. Unknown ones show as paused. A queued task blocked by a resource says "waiting for <resource> (used by <member>)". */
  reason: Schema.NullOr(Schema.String),
  /** The owner's hidden thread for the task's request, where the work happens. */
  threadId: ThreadId,
  /** The request it belongs to; absent from older servers. */
  requestId: Schema.optionalKey(AssistantGroupMessageId),
  /** What done looks like, as the assigner wrote it; absent when none was given. */
  expectedResult: Schema.optionalKey(Schema.String),
  /** Chat message numbers the subtask is based on. */
  sourceSeqs: Schema.optionalKey(Schema.Array(Schema.Int)),
  /** Normalized resources the task holds while it runs; tasks sharing one run in turn. */
  resources: Schema.optionalKey(Schema.Array(Schema.String)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AssistantGroupTask = typeof AssistantGroupTask.Type;

/** Stop and Resume act on any open task; Reassign and Cancel on a paused or failed one. */
export const AssistantGroupTaskAction = Schema.Literals(["stop", "resume", "reassign", "cancel"]);
export type AssistantGroupTaskAction = typeof AssistantGroupTaskAction.Type;

export function assistantGroupTaskActions(
  task: Pick<AssistantGroupTask, "status">,
): ReadonlyArray<AssistantGroupTaskAction> {
  switch (task.status) {
    case "queued":
    case "running":
    case "waiting":
      return ["stop"];
    case "paused":
      return ["resume", "reassign", "cancel"];
    case "failed":
      return ["resume", "reassign", "cancel"];
    case "completed":
    case "cancelled":
      return [];
  }
}

export const AssistantGroupsSubscribeInput = Schema.Struct({ teamId: AssistantTeamId });
export type AssistantGroupsSubscribeInput = typeof AssistantGroupsSubscribeInput.Type;

/** The first event is the newest page with its tasks; then each change as it lands. */
export const AssistantGroupsEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    messages: Schema.Array(AssistantGroupMessage),
    tasks: Schema.Array(AssistantGroupTask),
    hasMore: Schema.Boolean,
    /** First messages of the requests the page shows that lie before it. */
    requests: Schema.optionalKey(Schema.Array(AssistantGroupMessage)),
  }),
  Schema.Struct({ type: Schema.Literal("message"), message: AssistantGroupMessage }),
  Schema.Struct({ type: Schema.Literal("task"), task: AssistantGroupTask }),
]);
export type AssistantGroupsEvent = typeof AssistantGroupsEvent.Type;

export const AssistantGroupsHistoryInput = Schema.Struct({
  teamId: AssistantTeamId,
  /** Messages before this seq; the newest page when absent. */
  beforeSeq: Schema.optional(Schema.Int),
});
export type AssistantGroupsHistoryInput = typeof AssistantGroupsHistoryInput.Type;

export const AssistantGroupsHistoryResult = Schema.Struct({
  messages: Schema.Array(AssistantGroupMessage),
  tasks: Schema.Array(AssistantGroupTask),
  hasMore: Schema.Boolean,
  /** First messages of the requests the page shows that lie before it. */
  requests: Schema.optionalKey(Schema.Array(AssistantGroupMessage)),
});
export type AssistantGroupsHistoryResult = typeof AssistantGroupsHistoryResult.Type;

/**
 * Sets how far the user has read; lower than before marks the later messages unread again.
 * `unread` instead moves it to just before the newest message the user did not write.
 */
export const AssistantGroupsMarkReadInput = Schema.Struct({
  teamId: AssistantTeamId,
  readSeq: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  unread: Schema.optional(Schema.Boolean),
});
export type AssistantGroupsMarkReadInput = typeof AssistantGroupsMarkReadInput.Type;

export const AssistantGroupsMarkReadResult = Schema.Struct({ readSeq: Schema.Int });
export type AssistantGroupsMarkReadResult = typeof AssistantGroupsMarkReadResult.Type;

/**
 * `new` and `compact` draw a boundary (compact first writes a summary of the chat); `undo` removes
 * the latest boundary while nothing came after it; `clear` deletes the chat. All but `undo` refuse
 * while the group is working.
 */
export const AssistantGroupConversationAction = Schema.Literals([
  "new",
  "compact",
  "undo",
  "clear",
]);
export type AssistantGroupConversationAction = typeof AssistantGroupConversationAction.Type;

export const AssistantGroupsConversationInput = Schema.Struct({
  teamId: AssistantTeamId,
  action: AssistantGroupConversationAction,
});
export type AssistantGroupsConversationInput = typeof AssistantGroupsConversationInput.Type;

export const AssistantGroupsConversationResult = Schema.Struct({ teamId: AssistantTeamId });
export type AssistantGroupsConversationResult = typeof AssistantGroupsConversationResult.Type;

export const AssistantGroupsPostInput = Schema.Struct({
  teamId: AssistantTeamId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_GROUP_MESSAGE_MAX_CHARS)),
  /** A message of a request: the post continues that request, and a member's task owner gets it. */
  replyToMessageId: Schema.optional(AssistantGroupMessageId),
  /** A new request's project, one of the group's; absent lets the lead decide. */
  projectId: Schema.optional(ProjectId),
  /** A repeat with the same id posts nothing more. */
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  /** Pending uploads, as for a thread message; the server keeps them with the message. */
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
});
export type AssistantGroupsPostInput = typeof AssistantGroupsPostInput.Type;

export const AssistantGroupsPostResult = Schema.Struct({
  message: AssistantGroupMessage,
  tasks: Schema.Array(AssistantGroupTask),
});
export type AssistantGroupsPostResult = typeof AssistantGroupsPostResult.Type;

export const AssistantGroupsTaskActionInput = Schema.Struct({
  taskId: AssistantGroupTaskId,
  action: AssistantGroupTaskAction,
  /** reassign: the member that takes it. */
  ownerId: Schema.optional(AssistantId),
});
export type AssistantGroupsTaskActionInput = typeof AssistantGroupsTaskActionInput.Type;

export const ASSISTANT_GROUP_EVERYONE = "everyone";

/**
 * The projects a group's requests may run in, in member order: each member's listed projects, or
 * its home project when it may work anywhere.
 */
export function assistantGroupProjectIds(
  members: ReadonlyArray<Pick<Assistant, "projectId" | "projectIds">>,
): ReadonlyArray<ProjectId> {
  return [
    ...new Set(
      members.flatMap((member) =>
        member.projectIds.length > 0 ? member.projectIds : [member.projectId],
      ),
    ),
  ];
}

/** Lowercase with accents dropped, one UTF-16 unit for one unit, so offsets still index the original. */
export function foldAssistantGroupText(text: string): string {
  let folded = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    folded += char.normalize("NFD")[0]!.toLowerCase()[0] ?? char;
  }
  return folded;
}

export interface AssistantGroupMention<M> {
  readonly start: number;
  readonly end: number;
  /** The member named; null for `@everyone`. */
  readonly member: M | null;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Code and links hold `@` that is not an address; blanking keeps offsets. */
const UNADDRESSABLE = /```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/\S+|www\.\S+/g;
const BEFORE_AT = /[\p{L}\p{N}_]/u;
const NAME_END = String.raw`(?![\p{L}\p{N}_-])`;

/**
 * Every `@mention` in the text, in order: `@everyone`, or a member by handle or full name (spaces
 * allowed, longest name wins, case and accents ignored). An `@` inside code, a link, or an email
 * is skipped. The server decides recipients from this; clients highlight and preview with it.
 */
export function assistantGroupMentions<
  M extends { readonly handle: string; readonly name: string },
>(text: string, members: ReadonlyArray<M>): ReadonlyArray<AssistantGroupMention<M>> {
  // Clients run this for every rendered message; most have no `@` at all.
  if (!text.includes("@")) return [];
  const blanked = text.replace(UNADDRESSABLE, (match) => " ".repeat(match.length));
  const folded = foldAssistantGroupText(blanked);
  const candidates = members.flatMap((member) => {
    const name = foldAssistantGroupText(member.name).trim().replace(/\s+/g, " ");
    const forms = [foldAssistantGroupText(member.handle), name.replace(/ /g, ""), name]
      .filter((form, index, all) => form !== "" && all.indexOf(form) === index)
      .map((form) =>
        form
          .split(" ")
          .map(escapeRegExp)
          .join(String.raw`\s+`),
      );
    return forms.map((form) => ({ member, regex: new RegExp(form + NAME_END, "uy") }));
  });
  const everyone = new RegExp("everyone" + NAME_END, "uy");
  const found: AssistantGroupMention<M>[] = [];
  for (let at = folded.indexOf("@"); at >= 0; at = folded.indexOf("@", at + 1)) {
    if (at > 0 && BEFORE_AT.test(folded[at - 1]!)) continue;
    const start = at + 1;
    everyone.lastIndex = start;
    let best: { end: number; member: M | null } | null = everyone.test(folded)
      ? { end: everyone.lastIndex, member: null }
      : null;
    for (const { member, regex } of candidates) {
      regex.lastIndex = start;
      if (regex.test(folded) && (best === null || regex.lastIndex > best.end)) {
        best = { end: regex.lastIndex, member };
      }
    }
    if (best !== null) {
      found.push({ start: at, end: best.end, member: best.member });
      at = best.end - 1;
    }
  }
  return found;
}

/**
 * How a `#mention` names a project on its own: its title folded, each run of anything but letters
 * and digits a hyphen. A title with neither is `project`. Use `assistantGroupProjectSlugs` for a
 * group's list, where titles may collide.
 */
export function assistantGroupProjectSlug(name: string): string {
  const slug = foldAssistantGroupText(name.normalize("NFC"))
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return slug === "" ? "project" : slug;
}

/**
 * Each project's `#slug`, by id. Titles that make the same slug get `-2`, `-3`… in id order,
 * skipping slugs another title makes, so the same projects in any order get the same slugs.
 */
export function assistantGroupProjectSlugs(
  projects: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): ReadonlyMap<string, string> {
  const sorted = [...projects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const natural = new Set(sorted.map((project) => assistantGroupProjectSlug(project.name)));
  const used = new Set<string>();
  const slugs = new Map<string, string>();
  for (const project of sorted) {
    const base = assistantGroupProjectSlug(project.name);
    let slug = base;
    for (let n = 2; used.has(slug) || (slug !== base && natural.has(slug)); n += 1) {
      slug = `${base}-${n}`;
    }
    used.add(slug);
    slugs.set(project.id, slug);
  }
  return slugs;
}

const PROJECT_MENTION = /(?:^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}_./-]*)/gu;

/**
 * Each `#slug` in the text that names one of the projects, in order, with its offsets. A `#`
 * inside code or a link, a heading's `# `, and a `#word` that is no project are ignored.
 */
export function assistantGroupProjectMentionRanges<
  P extends { readonly id: string; readonly name: string },
>(
  text: string,
  projects: ReadonlyArray<P>,
): ReadonlyArray<{ readonly start: number; readonly end: number; readonly project: P }> {
  if (!text.includes("#")) return [];
  const blanked = text.replace(UNADDRESSABLE, (match) => " ".repeat(match.length));
  const slugs = assistantGroupProjectSlugs(projects);
  const found: Array<{ start: number; end: number; project: P }> = [];
  for (const match of blanked.matchAll(PROJECT_MENTION)) {
    const word = match[1]!.replace(/[./-]+$/, "");
    const token = foldAssistantGroupText(word.normalize("NFC"));
    const project = projects.find((candidate) => slugs.get(candidate.id) === token);
    if (project === undefined) continue;
    const start = match.index + match[0].length - match[1]!.length - 1;
    found.push({ start, end: start + 1 + word.length, project });
  }
  return found;
}

/** The projects a text names with `#slug`, each once, in order. */
export function assistantGroupProjectMentions<
  P extends { readonly id: string; readonly name: string },
>(text: string, projects: ReadonlyArray<P>): ReadonlyArray<P> {
  return [
    ...new Set(assistantGroupProjectMentionRanges(text, projects).map((found) => found.project)),
  ];
}

/**
 * The members a message addresses with an `@` anywhere in it (`@everyone` is all of them), each
 * once, in order. Null when it names nobody, so a deterministic rule or the lead takes over.
 */
export function assistantGroupAddress<
  M extends { readonly id: string; readonly handle: string; readonly name: string },
>(text: string, members: ReadonlyArray<M>): ReadonlyArray<M> | null {
  const picked: M[] = [];
  for (const mention of assistantGroupMentions(text, members)) {
    if (mention.member === null) return members.length === 0 ? null : members;
    if (!picked.includes(mention.member)) picked.push(mention.member);
  }
  return picked.length === 0 ? null : picked;
}

/** A member's hidden thread for one group; the suffix is a hash of the group id. */
const GROUP_THREAD_SUFFIX = /:g-[0-9a-f]{16}$/;
export function isAssistantGroupThreadId(threadId: string): boolean {
  return threadId.startsWith("assistant:") && GROUP_THREAD_SUFFIX.test(threadId);
}
