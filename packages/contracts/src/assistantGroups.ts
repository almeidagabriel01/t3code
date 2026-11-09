import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AssistantId, AssistantTeamId } from "./assistants.ts";
import { ChatAttachment, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";

/**
 * A group's shared chat, as in an OpenBot channel. A message there runs no agent itself: it opens
 * one task per recipient, and each member works it in its own hidden thread for that group.
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
/** Automatic assignments and transfers per request; the next one pauses until the user acts. */
export const ASSISTANT_GROUP_HANDOFF_LIMIT = 8;
/** Member-to-member replies per request, whoever writes them. */
export const ASSISTANT_GROUP_REPLY_LIMIT = 2;
export const ASSISTANT_GROUP_REPLY_MAX_CHARS = 500;
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
  /** Why it paused: stopped, handoff_limit, member_removed, group_archived. Unknown ones show as paused. */
  reason: Schema.NullOr(Schema.String),
  /** The owner's hidden thread for this group, where the work happens. */
  threadId: ThreadId,
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
  /** A member's message this answers: its task's owner gets the follow-up. */
  replyToMessageId: Schema.optional(AssistantGroupMessageId),
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
 * The members a message opens with: `@everyone`, or leading `@handle` tokens (a name with no
 * spaces also matches, case-insensitive). Null when it opens with no known mention, so the lead
 * routes it. The server decides; clients use it to preview who will get the message.
 */
export function assistantGroupLeadingAddress<
  M extends { readonly id: string; readonly handle: string; readonly name: string },
>(text: string, members: ReadonlyArray<M>): ReadonlyArray<M> | null {
  const picked: M[] = [];
  const pattern = /^\s*@([\p{L}\p{N}_-]+)[,:]?/u;
  let rest = text;
  for (let match = pattern.exec(rest); match !== null; match = pattern.exec(rest)) {
    const token = match[1]!.toLowerCase();
    if (token === ASSISTANT_GROUP_EVERYONE) return members.length === 0 ? null : members;
    const member = members.find(
      (candidate) =>
        candidate.handle === token || candidate.name.toLowerCase().replace(/\s+/g, "") === token,
    );
    if (member === undefined) break;
    if (!picked.includes(member)) picked.push(member);
    rest = rest.slice(match[0].length);
  }
  return picked.length === 0 ? null : picked;
}

/** A member's hidden thread for one group; the suffix is a hash of the group id. */
const GROUP_THREAD_SUFFIX = /:g-[0-9a-f]{16}$/;
export function isAssistantGroupThreadId(threadId: string): boolean {
  return threadId.startsWith("assistant:") && GROUP_THREAD_SUFFIX.test(threadId);
}
