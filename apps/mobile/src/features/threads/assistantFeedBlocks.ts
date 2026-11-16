import { continuesAssistantSender } from "@t3tools/client-runtime/assistantPresence";
import {
  teammateMessageIsLong,
  type TeammateMessagePart,
} from "@t3tools/client-runtime/teammateMessage";
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

/** A group's replies arrive as one message: one block per teammate, else one for its sender. */
export function assistantFeedBlocks(input: {
  readonly message: { readonly id: string; readonly senderThreadId?: string | undefined };
  readonly parts: ReadonlyArray<TeammateMessagePart> | undefined;
  readonly presenceAssistantId: string | null;
  readonly renderedText: string;
  /** Assistants this message brings into the conversation. */
  readonly joins: ReadonlyArray<string> | undefined;
  /** It follows a message from the same assistant. */
  readonly continued: boolean;
}): ReadonlyArray<AssistantFeedBlock> {
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
      joined: input.joins?.includes(assistantId) ?? false,
      showTimestamp: index === parts.length - 1,
      continues: parts.length === 1 && input.continued,
      long: teammateMessageIsLong(text),
    };
  });
}

/** Messages that continue the one right above them from the same assistant; null breaks a run. */
export function assistantContinuedMessageIds(
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
