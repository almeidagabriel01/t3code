import { assistantIdFromThreadId, type Assistant } from "@t3tools/contracts";

import { assistantFace, type AssistantFace, type AssistantPresence } from "./assistantRobot.ts";
import { ASSISTANT_TASK_FACE, type AssistantTaskState } from "./assistantTasks.ts";

/** Distinct hues that read on dark, light and glass surfaces. */
export const ASSISTANT_ACCENTS = [
  "#8b5cf6",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
] as const;

/** The same assistant keeps the same color on every client. */
export function assistantAccent(assistantId: string): string {
  let hash = 0;
  for (const char of assistantId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ASSISTANT_ACCENTS[hash % ASSISTANT_ACCENTS.length]!;
}

export interface AssistantSender {
  readonly assistantId: string;
  /** Null when the assistant was deleted since; the message still shows who sent it. */
  readonly assistant: Assistant | null;
  readonly firstMessageId: string;
  readonly lastMessageId: string;
  readonly count: number;
}

/** The assistant that sent a message, from the message's sender thread; null for anyone else. */
export function messageAssistantId(message: { readonly senderThreadId?: string | undefined }) {
  return message.senderThreadId ? assistantIdFromThreadId(message.senderThreadId) : null;
}

/** Assistants that wrote into a thread, in the order they first spoke. */
export function assistantSenders(
  messages: ReadonlyArray<{ readonly id: string; readonly senderThreadId?: string | undefined }>,
  assistants: ReadonlyArray<Assistant>,
): ReadonlyArray<AssistantSender> {
  const byId = new Map<string, AssistantSender>();
  for (const message of messages) {
    const assistantId = messageAssistantId(message);
    if (assistantId === null) continue;
    const previous = byId.get(assistantId);
    byId.set(assistantId, {
      assistantId,
      assistant: assistants.find((candidate) => candidate.id === assistantId) ?? null,
      firstMessageId: previous?.firstMessageId ?? message.id,
      lastMessageId: message.id,
      count: (previous?.count ?? 0) + 1,
    });
  }
  return [...byId.values()];
}

/**
 * The thread's assistants behind its one header control: who wrote here, and first the assistant
 * that launched it as a task when that one has not written here yet (`count` 0, no message ids).
 */
export function assistantThreadSenders(
  senders: ReadonlyArray<AssistantSender>,
  taskOwner: Assistant | null,
): ReadonlyArray<AssistantSender> {
  if (taskOwner === null || senders.some((sender) => sender.assistantId === taskOwner.id)) {
    return senders;
  }
  const owner = { assistantId: taskOwner.id, assistant: taskOwner, count: 0 };
  return [{ ...owner, firstMessageId: "", lastMessageId: "" }, ...senders];
}

/**
 * A sender's face and Working/Idle section, from one reading: the assistant that launched the
 * thread as a task wears the task's state, everyone else their own presence.
 */
export function assistantSenderLook(
  sender: Pick<AssistantSender, "assistantId" | "assistant">,
  presence: AssistantPresence | undefined,
  task: { readonly assistantId: string; readonly state: AssistantTaskState } | null,
): { readonly face: AssistantFace; readonly working: boolean } {
  if (task !== null && task.assistantId === sender.assistantId) {
    return {
      face: ASSISTANT_TASK_FACE[task.state],
      working: task.state === "running" || task.state === "waiting",
    };
  }
  const working = presence?.mood === "working";
  return { face: sender.assistant && presence ? assistantFace(presence) : "sleeping", working };
}

/** A presence row's one status line: "Idle · 6 messages here · Asks before acting". */
export function assistantPresenceStatus(
  working: boolean,
  sender: Pick<AssistantSender, "count">,
  asksBeforeActing: boolean,
): string {
  return [
    working ? "Working" : "Idle",
    ...(sender.count === 0 ? [] : [`${sender.count} message${sender.count === 1 ? "" : "s"} here`]),
    ...(asksBeforeActing ? ["Asks before acting"] : []),
  ].join(" · ");
}

/** The thread's assistants split into Working, then Idle, each keeping the order they spoke in. */
export function assistantPresenceSections<S>(
  senders: ReadonlyArray<S>,
  isWorking: (sender: S) => boolean,
): { readonly working: ReadonlyArray<S>; readonly idle: ReadonlyArray<S> } {
  const working: S[] = [];
  const idle: S[] = [];
  for (const sender of senders) (isWorking(sender) ? working : idle).push(sender);
  return { working, idle };
}
