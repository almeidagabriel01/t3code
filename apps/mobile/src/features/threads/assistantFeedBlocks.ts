import {
  assistantJoins,
  continuesAssistantSender,
} from "@t3tools/client-runtime/assistantPresence";
import { isLongMessage } from "@t3tools/client-runtime/messageFold";
import type { TeammateMessagePart } from "@t3tools/client-runtime/teammateMessage";
import { assistantIdFromThreadId, assistantTransferList } from "@t3tools/contracts";
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";

type FeedMessage = Parameters<typeof continuesAssistantSender>[0] & { readonly id: string };

export interface AssistantFeedBlock {
  readonly key: string;
  readonly assistantId: string;
  readonly threadId: string | undefined;
  readonly fallbackName: string | undefined;
  readonly status: TeammateMessagePart["status"];
  readonly text: string;
  readonly joined: boolean;
  readonly showTimestamp: boolean;
  readonly continues: boolean;
  readonly long: boolean;
}

export interface AssistantFeedIndex {
  /** The assistants each message brings into the conversation. */
  readonly joins: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Messages that follow one from the same assistant. */
  readonly continued: ReadonlySet<string>;
}

/** Who joins where and which messages continue a run, for one feed (other rows break runs). */
export function assistantFeedIndex(
  feed: ReadonlyArray<{ readonly type: string; readonly message?: FeedMessage }>,
): AssistantFeedIndex {
  const messages = feed.map((entry) =>
    entry.type === "message" && entry.message ? entry.message : null,
  );
  return {
    joins: assistantJoins(messages.filter((message) => message !== null)),
    continued: assistantContinuedMessageIds(messages),
  };
}

/**
 * How an assistant's or teammates' message shows: a group's replies arrive as one message, one
 * block per teammate, else one block for its sender. Null for anyone else's message.
 */
export function assistantFeedBlocks(input: {
  readonly message: { readonly id: string; readonly senderThreadId?: string | undefined };
  readonly parts: ReadonlyArray<TeammateMessagePart> | undefined;
  readonly presenceAssistantId: string | null;
  readonly renderedText: string;
  readonly index: AssistantFeedIndex;
}): ReadonlyArray<AssistantFeedBlock> | null {
  if (input.parts === undefined && input.presenceAssistantId === null) return null;
  const joins = input.index.joins.get(input.message.id);
  const continued = input.index.continued.has(input.message.id);
  const parts = input.parts ?? [null];
  return parts.map((part, index) => {
    const assistantId =
      (part === null ? null : assistantIdFromThreadId(part.threadId)) ??
      input.presenceAssistantId ??
      part?.threadId ??
      "";
    const text =
      part === null
        ? input.renderedText
        : renderAssistantCitationsAsText(
            part.files.length === 0
              ? part.text
              : `${part.text}\n\n${assistantTransferList(part.files)}`,
          );
    return {
      key: part === null ? input.message.id : `${part.kind}:${part.threadId}:${part.requestId}`,
      assistantId,
      threadId: part?.threadId || input.message.senderThreadId,
      fallbackName: part?.name,
      status: part?.status,
      text,
      joined: joins?.includes(assistantId) ?? false,
      showTimestamp: index === parts.length - 1,
      continues: parts.length === 1 && continued,
      long: isLongMessage(text),
    };
  });
}

/** Messages that continue the one right above them from the same assistant; null breaks a run. */
function assistantContinuedMessageIds(
  feed: ReadonlyArray<FeedMessage | null>,
): ReadonlySet<string> {
  const continued = new Set<string>();
  feed.forEach((message, index) => {
    if (message !== null && continuesAssistantSender(message, feed[index - 1] ?? undefined)) {
      continued.add(message.id);
    }
  });
  return continued;
}
