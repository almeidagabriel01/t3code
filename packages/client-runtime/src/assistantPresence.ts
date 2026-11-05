import { assistantIdFromThreadId, type Assistant } from "@t3tools/contracts";

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

export function assistantInitial(name: string): string {
  return (name.trim()[0] ?? "?").toLocaleUpperCase();
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
