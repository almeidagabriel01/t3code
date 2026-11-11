import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  MessageId,
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { setStartingSideChat } from "../../state/starting-side-chats";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShell } from "./threadForkNavigation";
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
    if (!(await waitForThreadShell(scopeThreadRef(environmentId, targetThreadId)))) {
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

/**
 * Forks `source` at its latest stable point into a side chat and sends `prompt` there. Its
 * screen opens with the message at once and shows a failed start; resolves false when it did
 * not start. `settings` are what the parent's composer would send, which its thread gets only
 * on its next send.
 */
export function useStartSideChatWithPrompt() {
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const setRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const openLinkedThread = useOpenLinkedThread();

  return async (
    source: ScopedThreadRef,
    prompt: string,
    settings: { readonly runtimeMode: RuntimeMode; readonly modelSelection: ModelSelection },
  ): Promise<boolean> => {
    const targetThreadId = ThreadId.make(uuidv4());
    setStartingSideChat(targetThreadId, { prompt, error: null });
    openLinkedThread({ environmentId: source.environmentId, threadId: targetThreadId });
    const fail = (
      failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
      fallback: string,
      created: boolean,
    ) => {
      const error = isAtomCommandInterrupted(failure) ? null : squashAtomCommandFailure(failure);
      setStartingSideChat(targetThreadId, {
        prompt,
        error: error instanceof Error ? error.message : fallback,
      });
      // Drops the empty side chat a failed start leaves behind; one that got its message stays.
      if (created) {
        void deleteThread({
          environmentId: source.environmentId,
          input: { threadId: targetThreadId, onlyIfUnused: true },
        });
      }
      return false;
    };
    const fork = await forkSideChat({
      environmentId: source.environmentId,
      input: {
        sourceThreadId: source.threadId,
        targetThreadId,
        title: "Side chat",
        creationSource: "mobile",
      },
    });
    if (fork._tag === "Failure") return fail(fork, "Could not start a side chat.", false);
    // A fork starts with its parent's mode, so only a mode changed in the composer needs setting.
    const parent = appAtomRegistry.get(environmentThreadShells.threadShellAtom(source));
    if (settings.runtimeMode !== parent?.runtimeMode) {
      const mode = await setRuntimeMode({
        environmentId: source.environmentId,
        input: {
          threadId: targetThreadId,
          runtimeMode: settings.runtimeMode,
          createdAt: new Date().toISOString(),
        },
      });
      if (mode._tag === "Failure") {
        return fail(mode, "Could not set the side chat's permission mode.", true);
      }
    }
    const turn = await startTurn({
      environmentId: source.environmentId,
      input: {
        threadId: targetThreadId,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          text: prompt,
          attachments: [],
        },
        modelSelection: settings.modelSelection,
        titleSeed: deriveThreadTitleSeed({ text: prompt, attachments: [] }),
        runtimeMode: settings.runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      },
    });
    if (turn._tag === "Failure") return fail(turn, "Could not send the side chat message.", true);
    // A slow link gets a few waits for the shell; the route's own loading screen covers a later one.
    const targetRef = scopeThreadRef(source.environmentId, targetThreadId);
    for (let waits = 0; waits < 4 && !(await waitForThreadShell(targetRef)); waits++);
    setStartingSideChat(targetThreadId, null);
    return true;
  };
}
