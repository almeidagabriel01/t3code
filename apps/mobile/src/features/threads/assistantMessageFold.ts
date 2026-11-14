import { isLongMessage } from "@t3tools/client-runtime/messageFold";
import { isAssistantThreadId } from "@t3tools/contracts";

export const ASSISTANT_FOLDED_HEIGHT = 240;

/** Only a finished long reply in an assistant thread folds; a live or normal one stays open. */
export function isAssistantMessageFoldable(input: {
  readonly threadId: string;
  readonly streaming: boolean;
  readonly turnInProgress: boolean;
  readonly text: string;
}) {
  return (
    isAssistantThreadId(input.threadId) &&
    !input.streaming &&
    !input.turnInProgress &&
    isLongMessage(input.text)
  );
}
