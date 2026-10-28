import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type KanbanCard,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { newMessageId, newThreadId } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject } from "../../state/entities";
import {
  EMPTY_SERVER_PROVIDERS,
  environmentServerConfigsAtom,
  serverEnvironment,
} from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { withMessageContext } from "../ChatView.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { kanbanCardContextRecord } from "./kanban.logic";
import { reportKanbanError, useKanbanActions } from "./useKanban";

function LaunchForm(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
  readonly onClose: () => void;
}) {
  const { environmentId, board, card } = props;
  const navigate = useNavigate();
  const actions = useKanbanActions(environmentId);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    label: "kanban start with agent",
  });
  const project = useProject({ environmentId, projectId: board.projectId });
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      board.projectId,
    ),
  );
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [useWorktree, setUseWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("main");
  const [launching, setLaunching] = useState(false);

  const selection =
    picked !== null &&
    entries.some((entry) => entry.instanceId === picked.instanceId && entry.enabled)
      ? picked
      : scheduledTaskDefaultModel(settings, project, entries);
  const activeInstanceId =
    selection?.instanceId ?? entries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );

  const launch = async () => {
    if (selection === null || project === null || launching) return;
    setLaunching(true);
    const threadId = newThreadId();
    const record = kanbanCardContextRecord(card, board);
    const reference = formatComposerContextReference({
      kind: "kanban-card",
      contextId: record.contextId,
      label: record.label,
    });
    const interactionMode = "default" as const;
    const runtimeMode = DEFAULT_RUNTIME_MODE;
    const title = `#${card.number} ${card.title}`;
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          attachments: [],
          ...withMessageContext({
            text: `Work on card ${reference}`,
            context: { version: 1, records: [record] },
            supportsInlineMessageContext:
              appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
                .capabilities.inlineMessageContext === true,
          }),
        },
        modelSelection: selection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        createdAt: new Date().toISOString(),
        bootstrap: {
          createThread: {
            projectId: project.id,
            title,
            modelSelection: selection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
          ...(useWorktree && baseBranch.trim().length > 0
            ? {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: baseBranch.trim(),
                },
                runSetupScript: true,
              }
            : {}),
        },
      },
    });
    if (result._tag === "Failure") {
      setLaunching(false);
      reportKanbanError("Could not start the agent", squashAtomCommandFailure(result));
      return;
    }
    await actions.linkCardThread({ cardId: card.id, threadId });
    props.onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: scopeThreadRef(environmentId, threadId),
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Start with agent</DialogTitle>
        <DialogDescription>
          Launch a thread for #{card.number} with the card as context, and link it to the card.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Model</Label>
            <div>
              <ProviderModelPicker
                environmentId={environmentId}
                disabled={launching}
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                onInstanceModelChange={(instanceId, model) => setPicked({ instanceId, model })}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="kanban-worktree">New worktree</Label>
            <Switch
              id="kanban-worktree"
              checked={useWorktree}
              onCheckedChange={(checked) => setUseWorktree(Boolean(checked))}
            />
          </div>
          {useWorktree ? (
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-base">Base branch</Label>
              <Input
                id="kanban-base"
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
              />
            </div>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button disabled={selection === null || project === null || launching} onClick={launch}>
          <BotIcon />
          Start
        </Button>
      </DialogFooter>
    </>
  );
}

export function KanbanStartAgentButton(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" disabled={props.disabled} onClick={() => setOpen(true)}>
        <BotIcon />
        Start with agent
      </Button>
      {open ? (
        <Dialog open onOpenChange={(next) => !next && setOpen(false)}>
          <DialogPopup className="max-w-md">
            <LaunchForm {...props} onClose={() => setOpen(false)} />
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}
