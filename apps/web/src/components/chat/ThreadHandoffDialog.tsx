import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  THREAD_HANDOFF_INSTRUCTIONS_MAX_CHARS,
  type ModelSelection,
  type OrchestrationV2ThreadHandoffMode,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeftIcon } from "lucide-react";
import { useState } from "react";

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
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveContextWindowModelDisplayName } from "./ContextWindowMeter.logic";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { openThreadHandoffDialog, threadHandoffDialogAtom } from "./threadHandoffDialogState";

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
        <ArrowRightLeftIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Hand off to another agent</TooltipPopup>
    </Tooltip>
  );
}

// The composer's model picker, dressed as a form field to match the Context select beside it.
const AGENT_FIELD_CLASSNAME =
  "h-7 w-full max-w-none border-input bg-background px-2.5 text-start font-normal text-foreground shadow-xs/5 hover:bg-accent/50 sm:h-7 sm:max-w-none sm:text-sm dark:bg-input/32";

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
  const [instructions, setInstructions] = useState("");
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
      input: {
        sourceThreadId: threadId,
        modelSelection: selection,
        mode,
        clientRequestId,
        ...(instructions.trim() === "" ? {} : { instructions: instructions.trim() }),
      },
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
                {thread === null
                  ? ""
                  : ` · ${resolveContextWindowModelDisplayName(thread.modelSelection, modelOptionsByInstance)}`}
              </div>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label>Agent</Label>
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
                triggerClassName={AGENT_FIELD_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  setPicked(createModelSelection(instanceId, model))
                }
              />
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
            <div className="grid min-w-0 gap-1.5">
              <Label>What should it do next?</Label>
              <Textarea
                aria-label="What should it do next?"
                value={instructions}
                disabled={starting}
                maxLength={THREAD_HANDOFF_INSTRUCTIONS_MAX_CHARS}
                placeholder="Optional"
                onChange={(event) => setInstructions(event.target.value)}
              />
              <p className="text-muted-foreground text-xs leading-relaxed">
                Optional. Goes at the top of the new agent's first message.
              </p>
            </div>
            {startsIn !== null ? (
              <p className="flex min-w-0 gap-1 text-muted-foreground text-xs">
                <span className="shrink-0">Starts in</span>
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="truncate font-mono text-foreground/80" dir="rtl" />}
                  >
                    <bdi dir="ltr">{startsIn}</bdi>
                  </TooltipTrigger>
                  <TooltipPopup>{startsIn}</TooltipPopup>
                </Tooltip>
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
