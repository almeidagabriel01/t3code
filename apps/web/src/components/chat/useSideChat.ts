import type {
  ModelSelection,
  OrchestrationMessageContext,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { setStartingSideChat } from "../../lib/sideChatPane";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { prepareTurnAttachments } from "./chatViewSend";

/** A side chat's first message: the question and the composer's attachments. */
export interface SideChatMessage {
  readonly prompt: string;
  readonly attachments: SideChatAttachments;
}

/** The images and files a side chat's first message carries, uploaded by the main send's path. */
export interface SideChatAttachments {
  readonly items: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  /** Waits for the uploads; rejects when one cannot go out. */
  readonly prepare: () => Promise<{
    readonly attachments: Awaited<ReturnType<typeof prepareTurnAttachments>>;
    readonly context: OrchestrationMessageContext | undefined;
  }>;
}

/**
 * Starts side chats from `threadRef`, or offers none when it is null. `open` forks the
 * thread's latest stable point, sends `prompt` there with `readSettings()`, the parent
 * composer's settings, and shows the tab: at once when there is a prompt or attachments. It resolves false
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
  const start = async (threadRef: ScopedThreadRef, message: SideChatMessage | undefined) => {
    const { runtimeMode, modelSelection } = input.readSettings();
    const text = message?.prompt.trim() ?? "";
    return message && (text || message.attachments.items.length > 0)
      ? send(threadRef, text, message.attachments, runtimeMode, modelSelection)
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
    attachments: SideChatAttachments,
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
    // The tab shows inline attachment references by their names, as the sent message does.
    setStartingSideChat(
      targetThreadId,
      replaceComposerContextReferences(text, (reference) => reference.label).trim() ||
        attachments.items.map((attachment) => attachment.name).join(", "),
    );
    panel.openSideChat(threadRef, targetThreadId);
    const fail = (created: boolean, report?: () => void) => {
      setStartingSideChat(targetThreadId, null);
      panel.closeSurface(threadRef, surfaceId);
      if (created) discard(threadRef, targetThreadId);
      report?.();
      return false;
    };
    // Uploads settle first, so one that cannot go out leaves no side chat behind.
    const prepared = await attachments
      .prepare()
      .catch((error: unknown) =>
        error instanceof Error ? error : new Error("Could not upload the attachments."),
      );
    if (prepared instanceof Error) return fail(false, () => input.onError(prepared.message));
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
        message: {
          messageId: newMessageId(),
          role: "user",
          text: text || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
          attachments: prepared.attachments,
          ...(prepared.context === undefined ? {} : { context: prepared.context }),
        },
        ...(modelSelection === undefined ? {} : { modelSelection }),
        titleSeed: deriveThreadTitleSeed({ text, attachments: attachments.items }),
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
  const open = async (message?: SideChatMessage) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    pendingRef.current = true;
    return start(threadRef, message).finally(() => {
      pendingRef.current = false;
    });
  };
  return { available: input.threadRef !== null, open: useStableCallback(open) };
}
