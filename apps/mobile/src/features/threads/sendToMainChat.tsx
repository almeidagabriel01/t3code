import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/** Appends to the parent's draft (after a blank line when it has text) and opens the parent to review. */
export function useSendToMainChat(
  environmentId: EnvironmentId,
  parentThreadId: ThreadId | null,
): ((text: string) => void) | undefined {
  const openLinkedThread = useOpenLinkedThread();
  if (parentThreadId === null) return undefined;
  return (text) => {
    const key = scopedThreadKey(scopeThreadRef(environmentId, parentThreadId));
    const current = getComposerDraftSnapshot(key).text;
    setComposerDraftText(key, current.trim().length === 0 ? text : `${current}\n\n${text}`);
    openLinkedThread({ environmentId, threadId: parentThreadId });
  };
}
