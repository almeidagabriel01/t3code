import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sideChatParentStatus, threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_RUNTIME_MODE,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquarePlusIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { ComposerHandleContext } from "../../composerHandleContext";
import { useClientSettings } from "../../hooks/useSettings";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { useStartingSideChats, type SideChatParentPanel } from "../../lib/sideChatPane";
import { readLocalApi } from "../../localApi";
import { hostRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundThreadContext } from "./backgroundThread";
import { useSideChat } from "./useSideChat";

const PARENT_TONE_CLASSES = {
  active: { text: "text-info-foreground", dot: "bg-info" },
  attention: {
    text: "text-amber-600 dark:text-amber-300/90",
    dot: "bg-amber-500 dark:bg-amber-300/90",
  },
  idle: { text: "text-muted-foreground", dot: "bg-muted-foreground/60" },
  error: { text: "text-red-600 dark:text-red-300/90", dot: "bg-red-500 dark:bg-red-300/90" },
} as const;

/** A side chat tab: its title, the main thread's status, Bring back, Turn into thread, Start over, Delete and Close, over the side chat's own chat. */
export default function SideChatPane(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  const { parentRef, threadId } = props;
  const threadRef = scopeThreadRef(parentRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent panel as host in the panel store
  useEffect(
    () => hostRightPanel(scopeThreadRef(parentRef.environmentId, threadId), parentRef),
    [parentRef, threadId],
  );
  const shell = useQuietThreadShell(threadRef);
  const startingPrompt = useStartingSideChats((prompts) => prompts[threadId]);
  const parent = useQuietThreadShell(parentRef);
  const snapshotLoaded = useEnvironmentShellHasSnapshot(parentRef.environmentId);
  const projection = useQuietThreadProjection(shell === null ? null : threadRef)?.projection;
  const canOperate = useEnvironmentScope(parentRef.environmentId, AuthOrchestrationOperateScope);
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const navigate = useNavigate();
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [bringingBack, setBringingBack] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const sideChat = useSideChat({
    threadRef: parentRef,
    readSettings: () => ({
      runtimeMode: parent?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      modelSelection: parent?.modelSelection,
    }),
    onError: (description) =>
      toastManager.add({ type: "error", title: "Could not start over", description }),
  });
  const parentStatus = parent === null ? null : sideChatParentStatus(parent);
  const mergeRun = projection ? resolveLatestMergeBackRun(projection) : null;
  // A pending merge-back would fail the main thread's queued message, so the server refuses it.
  const bringBackBlockedReason = !canOperate
    ? "This connection cannot change threads."
    : threadRuntimeIsActive(parent?.runtime)
      ? "Available when the main thread is idle."
      : mergeRun === null
        ? "Available after a finished reply."
        : null;

  const bringBack = async () => {
    if (bringBackBlockedReason !== null || mergeRun === null || bringingBack) return;
    setBringingBack(true);
    const result = await mergeBack({
      environmentId: parentRef.environmentId,
      input: { sourceThreadId: threadId, targetThreadId: parentRef.threadId, runId: mergeRun.id },
    });
    setBringingBack(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Brought back",
        description: "The main thread gets this side chat with your next message there.",
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not bring back the side chat",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const turnIntoThread = async () => {
    if (!canOperate || shell === null || promoting) return;
    setPromoting(true);
    const result = await updateMetadata({
      environmentId: parentRef.environmentId,
      input: { threadId, detachSideChat: true, regenerateTitle: true },
    });
    setPromoting(false);
    if (result._tag === "Success") {
      useRightPanelStore.getState().closeSurface(parentRef, `side-chat:${threadId}`);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not turn the side chat into a thread",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const deleteSideChat = async () => {
    if (!canOperate || shell === null || deleting) return;
    if (
      !(await confirmDiscard(
        [
          `Delete side chat "${shell.title}"?`,
          "This permanently clears its conversation history.",
        ].join("\n"),
      ))
    )
      return;
    setDeleting(true);
    const result = await deleteThread({
      environmentId: parentRef.environmentId,
      input: { threadId },
    });
    setDeleting(false);
    if (result._tag === "Success") {
      releaseComposerDraftUploads(threadRef);
      useComposerDraftStore.getState().clearDraftThread(threadRef);
      useRightPanelStore.getState().closeSurface(parentRef, `side-chat:${threadId}`);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not delete the side chat",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const confirmDiscard = async (message: string) => {
    if (!confirmThreadDelete) return true;
    const api = readLocalApi();
    if (!api) return false;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(message, { variant: "destructive" }),
    );
    return confirmed._tag === "Success" && confirmed.value;
  };

  const startOver = async () => {
    if (!canOperate || shell === null || restarting || deleting) return;
    if (
      !(await confirmDiscard(
        [
          `Start "${shell.title}" over?`,
          "This permanently clears its conversation history and opens a fresh side chat.",
        ].join("\n"),
      ))
    )
      return;
    setRestarting(true);
    // The new side chat opens first so a failed start leaves this one untouched.
    if (await sideChat.open()) {
      const result = await deleteThread({
        environmentId: parentRef.environmentId,
        input: { threadId },
      });
      useRightPanelStore.getState().closeSurface(parentRef, `side-chat:${threadId}`);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({ type: "error", title: "Could not delete the old side chat" });
      }
    }
    setRestarting(false);
  };

  return (
    <div data-side-chat-pane className="flex h-full min-h-0 flex-col">
      <div className="@container/side-chat flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {shell?.title ?? "Side chat"}
        </span>
        {parentStatus === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="status"
                  aria-label={`Main thread: ${parentStatus.label}`}
                  className={`inline-flex shrink-0 items-center gap-1 text-2xs ${PARENT_TONE_CLASSES[parentStatus.tone].text}`}
                  data-side-chat-parent-status={parentStatus.tone}
                />
              }
            >
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${PARENT_TONE_CLASSES[parentStatus.tone].dot}`}
              />
              <span className="@max-sm/side-chat:hidden">{parentStatus.label}</span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">Main thread: {parentStatus.label}</TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={bringBackBlockedReason !== null || bringingBack || undefined}
                onClick={() => void bringBack()}
              >
                Bring back
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {bringBackBlockedReason ?? "Adds this side chat to the main thread's next message."}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Turn into thread"
                disabled={!canOperate || shell === null || promoting}
                onClick={() => void turnIntoThread()}
              >
                <MessageSquarePlusIcon />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Keep this side chat as its own thread.</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Start over"
                disabled={!canOperate || shell === null || restarting || deleting}
                onClick={() => void startOver()}
              >
                <RotateCcwIcon />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Discard this side chat and start a fresh one.</TooltipPopup>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Delete side chat"
          disabled={!canOperate || shell === null || deleting}
          onClick={() => void deleteSideChat()}
        >
          <Trash2Icon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close side chat" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      {startingPrompt !== undefined ? (
        // Shown from the moment `/side` is sent, until the side chat has the message.
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <p className="max-w-[85%] self-end rounded-2xl bg-message px-3 py-2 text-sm break-words whitespace-pre-wrap text-message-foreground">
            {startingPrompt}
          </p>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size="xs" />
            Starting the side chat…
          </p>
        </div>
      ) : shell === null ? (
        snapshotLoaded ? (
          <p className="p-3 text-xs text-muted-foreground">This side chat was deleted.</p>
        ) : null
      ) : (
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={parentRef.environmentId}
              threadId={threadId}
              routeKind="server"
              embedded={props.parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      )}
    </div>
  );
}
