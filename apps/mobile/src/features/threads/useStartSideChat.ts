import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/** Forks `sourceThreadId`'s latest stable point into a new side chat and opens it; null when it failed. */
export function useStartSideChat(environmentId: EnvironmentId) {
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat);
  const openLinkedThread = useOpenLinkedThread();
  return async (
    sourceThreadId: ThreadId,
    options?: { readonly replace?: boolean },
  ): Promise<ThreadId | null> => {
    const targetThreadId = ThreadId.make(uuidv4());
    const result = await forkSideChat({
      environmentId,
      input: { sourceThreadId, targetThreadId, title: "Side chat" },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not start a side chat",
        cause instanceof Error ? cause.message : "Try again.",
      );
      return null;
    }
    openLinkedThread({ environmentId, threadId: targetThreadId }, options);
    return targetThreadId;
  };
}
