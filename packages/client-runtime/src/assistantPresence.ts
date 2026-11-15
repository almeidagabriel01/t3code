import { assistantIdFromThreadId, type Assistant } from "@t3tools/contracts";

import { assistantFace, type AssistantFace, type AssistantPresence } from "./assistantRobot.ts";
import { resolveTeammateMessage } from "./teammateMessage.ts";

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

type SenderMessage = Parameters<typeof resolveTeammateMessage>[0] & {
  readonly senderThreadId?: string | undefined;
};

/** One assistant wrote it; a group's replies carry several, and anyone else none. */
function soleAssistant(message: SenderMessage | undefined): string | null {
  if (message === undefined || message.role !== "user") return null;
  return (resolveTeammateMessage(message)?.length ?? 1) === 1 ? messageAssistantId(message) : null;
}

/**
 * Whether a message continues the one right above it from the same assistant, so clients show its
 * avatar and name once. Anything else between them (an answer, a work row) breaks the run.
 */
export function continuesAssistantSender(
  message: SenderMessage,
  previous: SenderMessage | undefined,
): boolean {
  const sender = soleAssistant(message);
  return sender !== null && sender === soleAssistant(previous);
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

export type AssistantPresenceSection = "needs" | "working" | "idle";

/** Section order and titles, the sidebar's order: Needs you, then Working, then Idle. */
export const ASSISTANT_PRESENCE_SECTIONS = [
  ["needs", "Needs you"],
  ["working", "Working"],
  ["idle", "Idle"],
] as const satisfies ReadonlyArray<readonly [AssistantPresenceSection, string]>;

/** A sender's face and section, both from its one `assistantStatus`. */
export function assistantSenderLook(
  sender: Pick<AssistantSender, "assistant">,
  status: AssistantPresence | undefined,
): { readonly face: AssistantFace; readonly section: AssistantPresenceSection } {
  const mood = status?.mood;
  return {
    face: sender.assistant && status ? assistantFace(status) : "sleeping",
    section: mood === "needs" ? "needs" : mood === "working" ? "working" : "idle",
  };
}

/** A presence row's one status line: "Idle · 6 messages here · Asks before acting". */
export function assistantPresenceStatus(
  section: AssistantPresenceSection,
  sender: Pick<AssistantSender, "count">,
  asksBeforeActing: boolean,
): string {
  const title = ASSISTANT_PRESENCE_SECTIONS.find(([id]) => id === section)![1];
  return [
    title,
    ...(sender.count === 0 ? [] : [`${sender.count} message${sender.count === 1 ? "" : "s"} here`]),
    ...(asksBeforeActing ? ["Asks before acting"] : []),
  ].join(" · ");
}

/** The thread's assistants by section, each keeping the order they spoke in. */
export function assistantPresenceSections<S>(
  senders: ReadonlyArray<S>,
  sectionOf: (sender: S) => AssistantPresenceSection,
): Record<AssistantPresenceSection, ReadonlyArray<S>> {
  const sections: Record<AssistantPresenceSection, S[]> = { needs: [], working: [], idle: [] };
  for (const sender of senders) sections[sectionOf(sender)].push(sender);
  return sections;
}
