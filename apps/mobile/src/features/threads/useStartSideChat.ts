import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "./threadForkNavigation";
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
    // Opening before the shell arrives shows an empty new-thread draft instead of the side chat.
    const shell = environmentThreadShells.threadShellAtom(
      scopeThreadRef(environmentId, targetThreadId),
    );
    if (!(await waitForThreadShellReady({ read: () => appAtomRegistry.get(shell) !== null }))) {
      Dialog.alert(
        "Side chat created",
        "It has not reached this device yet. Open it from the main thread's side chats.",
      );
      return null;
    }
    openLinkedThread({ environmentId, threadId: targetThreadId }, options);
    return targetThreadId;
  };
}
