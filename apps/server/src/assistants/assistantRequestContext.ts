import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AssistantDirectoryShape } from "./AssistantDirectory.ts";

/** G: a typed request this long after the last run ended starts a fresh provider session. */
export const ASSISTANT_REQUEST_GAP_MS = 10 * 60 * 1000;
/** C: past this many tokens in the provider's context, any turn starts a fresh session. */
export const ASSISTANT_CONTEXT_TOKEN_CEILING = 60_000;
/** S: the summary of earlier turns that a fresh session receives. */
export const ASSISTANT_SUMMARY_TOKEN_CAP = 4_000;

/** Only the fixed conversation; group threads (`:g-<hash>`) hold one request each. */
const ASSISTANT_CONVERSATION_ID = /^assistant:.+:\d+$/;
const CLIENT_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Allowlist: every other message (answers, replies, wakes, waits) continues the open request. */
const NEW_REQUEST_PREFIXES = ["channel:", "scheduled-task-message:", "message:mcp:"];

export const isAssistantConversationId = (threadId: string) =>
  ASSISTANT_CONVERSATION_ID.test(threadId);

export const opensAssistantRequest = (messageId: string) =>
  CLIENT_MESSAGE_ID.test(messageId) ||
  NEW_REQUEST_PREFIXES.some((prefix) => messageId.startsWith(prefix));

export type AssistantSessionCut = "new_request" | "context_ceiling";

/**
 * Why this turn of an assistant's conversation starts a fresh provider session, or null to resume.
 * The session is never cut under a run still at work.
 */
export function assistantSessionCut(input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly now: DateTime.Utc;
  readonly lastRunEndedAt: DateTime.Utc | null;
  readonly usedTokens: number | undefined;
  readonly otherRunActive: boolean;
}): AssistantSessionCut | null {
  if (!isAssistantConversationId(input.threadId) || input.otherRunActive) return null;
  if ((input.usedTokens ?? 0) > ASSISTANT_CONTEXT_TOKEN_CEILING) return "context_ceiling";
  return opensAssistantRequest(input.messageId) &&
    input.lastRunEndedAt !== null &&
    DateTime.toEpochMillis(input.now) - DateTime.toEpochMillis(input.lastRunEndedAt) >=
      ASSISTANT_REQUEST_GAP_MS
    ? "new_request"
    : null;
}

export interface AssistantOpenTask {
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
}

export const OPEN_TASKS_LIMIT = 10;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export function openTasksNote(tasks: ReadonlyArray<AssistantOpenTask>): string {
  const lines = tasks
    .slice(0, OPEN_TASKS_LIMIT)
    .map((task) => `- ${task.threadId} · ${oneLine(task.title, 120)} · ${task.status}`);
  return [
    "<t3_open_tasks>",
    "This turn starts a fresh session. Work you started that is still open:",
    ...(lines.length === 0 ? ["- none"] : lines),
    "</t3_open_tasks>",
  ].join("\n");
}

/** Threads this assistant delegated or launched that are still open. */
export const openTasksForCut = Effect.fn("AssistantRequestContext.openTasks")(function* (
  directory: Option.Option<AssistantDirectoryShape>,
  threadId: ThreadId,
  subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "childThreadId" | "title" | "prompt" | "status">
  >,
) {
  const delegated = subagents.flatMap((task) =>
    task.childThreadId === null || !isOrchestrationV2WorkActive(task.status)
      ? []
      : [{ threadId: task.childThreadId, title: task.title ?? task.prompt, status: task.status }],
  );
  const launched =
    Option.isNone(directory) || directory.value.openTasks === undefined
      ? []
      : yield* directory.value.openTasks(threadId);
  return openTasksNote([...delegated, ...launched]);
});
