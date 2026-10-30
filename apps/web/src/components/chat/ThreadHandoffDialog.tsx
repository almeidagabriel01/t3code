import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ModelSelection,
  OrchestrationV2ThreadHandoffMode,
  ProviderInstanceId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquarePlusIcon } from "lucide-react";
import { useState } from "react";
import { Atom } from "effect/reactivity";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useProject, useQuietThreadShell, waitForThreadShell } from "~/state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { OptionSelect } from "../kanban/kanbanDialogs";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderModelPicker } from "./ProviderModelPicker";

const CONTEXT_OPTIONS = [
  { value: "focused", label: "Focused (Recommended)" },
  { value: "full", label: "Full transcript" },
] as const satisfies ReadonlyArray<{
  readonly value: OrchestrationV2ThreadHandoffMode;
  readonly label: string;
}>;

const CONTEXT_HELP: Record<OrchestrationV2ThreadHandoffMode, string> = {
  focused:
    "Starts from the latest request and reply, and reads older details only when needed. Usually enough.",
  full: "Includes the saved transcript, the most recent part if it is very long. This takes longer and uses more context, plan usage, or API credits.",
};

/** Which thread has the hand-off dialog open. The header, thread menu and palette all open it. */
const threadHandoffDialogAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-handoff:dialog-thread"),
);

export function openThreadHandoffDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(threadHandoffDialogAtom, threadRef);
}

export function ThreadHandoffDialogHost() {
  const threadRef = useAtomValue(threadHandoffDialogAtom);
  if (threadRef === null) return null;
  return (
    <ThreadHandoffDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(threadHandoffDialogAtom, null)}
    />
  );
}

/** The thread header's way in. It shows only where the connection may start threads. */
export function ThreadHandoffButton({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const canHandoff = useAtomValue(
    orchestrationEnvironment.handoffThread.permissionAtom(threadRef.environmentId),
  );
  // Nothing to hand off before the first message.
  const hasMessage = useQuietThreadShell(threadRef)?.latestUserMessageAt != null;
  if (!canHandoff || !hasMessage) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className="shrink-0 [-webkit-app-region:no-drag]"
            variant="ghost"
            size="icon-sm"
            aria-label="Hand off to another agent"
            onClick={() => openThreadHandoffDialog(threadRef)}
          />
        }
      >
        <MessageSquarePlusIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Hand off to another agent</TooltipPopup>
    </Tooltip>
  );
}

function ThreadHandoffDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = threadRef;
  const navigate = useNavigate();
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread === null ? null : { environmentId, projectId: thread.projectId },
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canHandoff = useAtomValue(
    orchestrationEnvironment.handoffThread.permissionAtom(environmentId),
  );
  const handoff = useAtomCommand(orchestrationEnvironment.handoffThread, { reportFailure: false });
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [mode, setMode] = useState<OrchestrationV2ThreadHandoffMode>("focused");
  // One id per dialog, so a retry after a dropped reply returns the thread the first call started.
  const [clientRequestId] = useState(randomUUID);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entries = providerInstanceEntriesFor(providers, settings, thread?.projectId ?? null);
  const selection: ModelSelection | null =
    picked !== null &&
    entries.some((entry) => entry.instanceId === picked.instanceId && entry.enabled)
      ? picked
      : (thread?.modelSelection ?? null);
  const activeInstanceId = selection?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );
  const sourceEntry = entries.find((entry) => entry.instanceId === thread?.providerInstanceId);
  const startsIn = thread === null ? null : (thread.worktreePath ?? project?.workspaceRoot ?? null);

  const start = async () => {
    if (selection === null || starting) return;
    setStarting(true);
    setError(null);
    const result = await handoff({
      environmentId,
      input: { sourceThreadId: threadId, modelSelection: selection, mode, clientRequestId },
    });
    if (result._tag === "Failure") {
      setStarting(false);
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not start the new session.");
      }
      return;
    }
    const targetRef = scopeThreadRef(environmentId, result.value.threadId);
    if (!(await waitForThreadShell(targetRef))) {
      setStarting(false);
      setError(
        "The new session started, but it has not reached this client yet. Open it from the sidebar.",
      );
      return;
    }
    onClose();
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(targetRef) });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Hand off to another agent</DialogTitle>
          <DialogDescription>
            Start a fresh session from this stopping point. The original session stays unchanged.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid min-w-0 gap-4">
            <div className="min-w-0 rounded-lg border border-foreground/12 bg-foreground/4 px-3 py-2">
              <div className="truncate font-medium text-sm">
                {thread?.title ?? "Current session"}
              </div>
              <div className="mt-0.5 truncate text-muted-foreground text-xs">
                Agent: {sourceEntry?.displayName ?? thread?.providerInstanceId ?? "Unknown"}
                {thread === null ? "" : ` · ${thread.modelSelection.model}`}
              </div>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label>Agent</Label>
              <div>
                <ProviderModelPicker
                  environmentId={environmentId}
                  disabled={starting || selection === null}
                  activeInstanceId={activeInstanceId}
                  model={activeModel}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  triggerAriaLabel="Agent"
                  onInstanceModelChange={(instanceId, model) =>
                    setPicked(createModelSelection(instanceId, model))
                  }
                />
              </div>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label>Context</Label>
              <OptionSelect
                label="Context"
                value={mode}
                disabled={starting}
                options={CONTEXT_OPTIONS}
                onChange={setMode}
              />
              <p className="text-muted-foreground text-xs leading-relaxed">{CONTEXT_HELP[mode]}</p>
            </div>
            {startsIn !== null ? (
              <p className="min-w-0 text-muted-foreground text-xs">
                Starts in:{" "}
                <span className="break-all font-mono text-foreground/80">{startsIn}</span>
              </p>
            ) : null}
            {error !== null ? (
              <p role="alert" className="text-destructive text-xs">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void start()}
            disabled={!canHandoff || selection === null || starting}
          >
            {starting ? "Starting..." : "Start new session"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
