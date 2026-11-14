import type { ThreadId } from "@t3tools/contracts";

import { formatThreadLink } from "./threadLinks.ts";

/** The id prefix of the message T3 queues to an assistant when a task thread it launched ends a run. */
export const TASK_EVENT_MESSAGE_PREFIX = "assistant-task:";

export type TaskEventStatus = "completed" | "failed" | "cancelled" | "interrupted";

const OUTCOMES = {
  completed: "finished",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
} as const satisfies Record<TaskEventStatus, string>;

const STATUS_BY_OUTCOME = new Map<string, TaskEventStatus>(
  Object.entries(OUTCOMES).map(([status, outcome]) => [outcome, status as TaskEventStatus]),
);

const HEADLINE = /^Task \[(?<title>[^\]\n]*)\]\([^\n]*\) (?<outcome>[a-z]+)\.$/;

/** The first line of a task-event message; clients read the event back from it with `parseTaskEvent`. */
export function taskEventHeadline(input: {
  readonly title: string;
  readonly threadId: ThreadId;
  readonly status: TaskEventStatus;
}): string {
  // An empty label would make an autolink the parser cannot read back.
  const title = input.title.trim() || "Task";
  const link = formatThreadLink({ environmentId: null, threadId: input.threadId }, title);
  return `Task ${link} ${OUTCOMES[input.status]}.`;
}

export interface TaskEvent {
  readonly threadId: ThreadId;
  /** Null when the headline is not one T3 wrote; the task thread's own title stands in. */
  readonly title: string | null;
  readonly status: TaskEventStatus | null;
}

/** A queued task-event message, or null for any other message. */
export function parseTaskEvent(message: {
  readonly id: string;
  readonly text: string;
  readonly senderThreadId?: ThreadId | undefined;
}): TaskEvent | null {
  if (!message.id.startsWith(TASK_EVENT_MESSAGE_PREFIX) || message.senderThreadId === undefined) {
    return null;
  }
  const groups = HEADLINE.exec(message.text.split("\n", 1)[0] ?? "")?.groups;
  return {
    threadId: message.senderThreadId,
    title: groups?.title?.trim() || null,
    status: (groups?.outcome && STATUS_BY_OUTCOME.get(groups.outcome)) || null,
  };
}

/** What an assistant answers to an event that has nothing new for the user. */
export const QUIET_REPLY = "NO_REPLY";

const unwrapToken = (line: string) => line.trim().replace(/^[`*_]+|[`*_.!]+$/g, "");

/** True when the reply is only the quiet token, bare, punctuated or wrapped in Markdown. */
export function isQuietReply(text: string): boolean {
  return unwrapToken(text) === QUIET_REPLY;
}

/**
 * The reply without a quiet token on its last line: text before the token still tells the user
 * something, so it goes out and shows, and only the token is dropped.
 */
export function withoutQuietToken(text: string): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length < 2 || unwrapToken(lines.at(-1) ?? "") !== QUIET_REPLY) return text;
  return lines.slice(0, -1).join("\n").trimEnd();
}

/** A streamed last line that may still grow into the quiet token, such as `NO_`. */
export function mayBecomeQuietToken(line: string): boolean {
  const partial = unwrapToken(line);
  return partial !== "" && QUIET_REPLY.startsWith(partial);
}
