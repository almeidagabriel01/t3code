import type { ModelSelection, RuntimeMode, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { setStartingSideChat } from "../../lib/sideChatPane";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/**
 * Starts side chats from `threadRef`, or offers none when it is null. `open` forks the
 * thread's latest stable point, sends `prompt` there with `readSettings()`, the parent
 * composer's settings, and shows the tab: at once when there is a prompt. It resolves false
 * when the side chat did not start, or another one is still starting.
 */
export function useSideChat(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly readSettings: () => {
    readonly runtimeMode: RuntimeMode;
    readonly modelSelection: ModelSelection | undefined;
  };
  readonly onError: (message: string) => void;
}) {
  const pendingRef = useRef(false);
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const reportFailure = (
    failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    input.onError(error instanceof Error ? error.message : fallback);
  };
  const start = async (threadRef: ScopedThreadRef, prompt: string | undefined) => {
    const { runtimeMode, modelSelection } = input.readSettings();
    const text = prompt?.trim();
    return text
      ? send(threadRef, text, runtimeMode, modelSelection)
      : openEmpty(threadRef, runtimeMode, modelSelection);
  };
  // Drops the empty side chat a failed start leaves behind; one that got its message stays.
  const discard = (threadRef: ScopedThreadRef, targetThreadId: ThreadId) =>
    void deleteThread({
      environmentId: threadRef.environmentId,
      input: { threadId: targetThreadId, onlyIfUnused: true },
    });
  /**
   * The tab opens with the message before the server has the side chat, so a slow server never
   * leaves the text sitting in the main composer. A failed start closes the tab again.
   */
  const send = async (
    threadRef: ScopedThreadRef,
    text: string,
    runtimeMode: RuntimeMode,
    modelSelection: ModelSelection | undefined,
  ) => {
    const targetThreadId = newThreadId();
    const surfaceId = `side-chat:${targetThreadId}`;
    const panel = useRightPanelStore.getState();
    const tabOpen = () =>
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.some((surface) => surface.id === surfaceId);
    setStartingSideChat(targetThreadId, text);
    panel.openSideChat(threadRef, targetThreadId);
    const fail = (created: boolean, report?: () => void) => {
      setStartingSideChat(targetThreadId, null);
      panel.closeSurface(threadRef, surfaceId);
      if (created) discard(threadRef, targetThreadId);
      report?.();
      return false;
    };
    const fork = await forkSideChat({
      environmentId: threadRef.environmentId,
      input: { sourceThreadId: threadRef.threadId, targetThreadId, title: "Side chat" },
    });
    if (fork._tag === "Failure") {
      return fail(false, () => reportFailure(fork, "Could not start a side chat."));
    }
    // Closed while it started: the message goes back to the composer instead of running unseen.
    if (!tabOpen()) return fail(true);
    // A fork starts with its parent's mode, so only a mode changed in the composer needs setting.
    if (runtimeMode !== readThreadShell(threadRef)?.runtimeMode) {
      const mode = await setThreadRuntimeMode({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, runtimeMode, createdAt: new Date().toISOString() },
      });
      if (mode._tag === "Failure") {
        return fail(true, () =>
          reportFailure(mode, "Could not set the side chat's permission mode."),
        );
      }
      if (!tabOpen()) return fail(true);
    }
    const turn = await startThreadTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: targetThreadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        ...(modelSelection === undefined ? {} : { modelSelection }),
        titleSeed: deriveThreadTitleSeed({ text, attachments: [] }),
        runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      },
    });
    if (turn._tag === "Failure") {
      return fail(true, () => reportFailure(turn, "Could not send the side chat message."));
    }
    setStartingSideChat(targetThreadId, null);
    return true;
  };
  const openEmpty = async (
    threadRef: ScopedThreadRef,
    runtimeMode: RuntimeMode,
    modelSelection: ModelSelection | undefined,
  ) => {
    const targetThreadId = newThreadId();
    const fork = await forkSideChat({
      environmentId: threadRef.environmentId,
      input: { sourceThreadId: threadRef.threadId, targetThreadId, title: "Side chat" },
    });
    if (fork._tag === "Failure") {
      reportFailure(fork, "Could not start a side chat.");
      return false;
    }
    const targetRef = scopeThreadRef(threadRef.environmentId, targetThreadId);
    if (!(await waitForThreadShell(targetRef))) {
      input.onError("The side chat was created, but it did not reach this client.");
      discard(threadRef, targetThreadId);
      return false;
    }
    const sideChat = readThreadShell(targetRef);
    if (sideChat === null) {
      input.onError("The side chat is no longer available.");
      discard(threadRef, targetThreadId);
      return false;
    }
    if (runtimeMode !== sideChat.runtimeMode) {
      const mode = await setThreadRuntimeMode({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, runtimeMode, createdAt: new Date().toISOString() },
      });
      if (mode._tag === "Failure") {
        reportFailure(mode, "Could not set the side chat's permission mode.");
        discard(threadRef, targetThreadId);
        return false;
      }
    }
    if (modelSelection !== undefined) {
      useComposerDraftStore.getState().setModelSelection(targetRef, modelSelection);
    }
    useRightPanelStore.getState().openSideChat(threadRef, targetThreadId);
    return true;
  };
  const open = async (prompt?: string) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    pendingRef.current = true;
    return start(threadRef, prompt).finally(() => {
      pendingRef.current = false;
    });
  };
  return { available: input.threadRef !== null, open: useStableCallback(open) };
}
