import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type KanbanCard,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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
import { DEFAULT_INTERACTION_MODE } from "../../types";
import {
  EMPTY_SERVER_PROVIDERS,
  environmentServerConfigsAtom,
  serverEnvironment,
} from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { withMessageContext } from "../ChatView.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
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
import {
  kanbanCardContextRecord,
  kanbanStartText,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { OptionSelect } from "./kanbanDialogs";
import { reportKanbanError, useKanbanActions } from "./useKanban";

function LaunchForm(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly onClose: () => void;
}) {
  const { environmentId, board, cards } = props;
  const many = cards.length > 1;
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
  const [pickedRuntimeMode, setPickedRuntimeMode] = useState<RuntimeMode | null>(null);
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
  const activeEntry = entries.find((entry) => entry.instanceId === activeInstanceId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );

  // What a new thread in this project would start with.
  const runtimeMode =
    pickedRuntimeMode ??
    resolveProjectSettings(settings, board.projectId, project ?? undefined).settings
      .defaultRuntimeMode;

  const launchOne = async (card: KanbanCard, selection: ModelSelection, projectId: ProjectId) => {
    const threadId = newThreadId();
    const record = kanbanCardContextRecord(card, board);
    const reference = formatComposerContextReference({
      kind: "kanban-card",
      contextId: record.contextId,
      label: record.label,
    });
    const interactionMode = DEFAULT_INTERACTION_MODE;
    const title = `#${card.number} ${card.title}`;
    const parent = card.parentCardId === null ? undefined : board.cards.get(card.parentCardId);
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          attachments: [],
          ...withMessageContext({
            text: kanbanStartText(reference, parent),
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
            projectId,
            title,
            modelSelection: selection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
          ...(useWorktree && baseBranch.trim().length > 0 && project !== null
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
      reportKanbanError("Could not start the agent", squashAtomCommandFailure(result));
      return null;
    }
    await actions.linkCardThread({ cardId: card.id, threadId });
    return threadId;
  };

  const launch = async () => {
    if (selection === null || project === null || launching) return;
    setLaunching(true);
    let last: Awaited<ReturnType<typeof launchOne>> = null;
    for (const card of cards) {
      last = (await launchOne(card, selection, project.id)) ?? last;
    }
    props.onClose();
    // One thread opens right away; a batch stays on the board where the agents show up.
    if (last !== null && !many) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: scopeThreadRef(environmentId, last),
      });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{many ? "Start agents" : "Start with agent"}</DialogTitle>
        <DialogDescription>
          {many
            ? `Launch ${cards.length} threads, one per subtask, each with its card as context and linked to it.`
            : `Launch a thread for #${cards[0]?.number} with the card as context, and link it to the card.`}
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
                onInstanceModelChange={(instanceId, model) =>
                  setPicked(createModelSelection(instanceId, model))
                }
              />
            </div>
          </div>
          {activeEntry !== undefined && selection !== null ? (
            <div className="flex items-center justify-between gap-3">
              <Label>Effort</Label>
              <TraitsPicker
                provider={activeEntry.driverKind}
                instanceId={activeEntry.instanceId}
                models={activeEntry.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={false}
                disabled={launching}
                onModelOptionsChange={(options) =>
                  setPicked(createModelSelection(selection.instanceId, selection.model, options))
                }
              />
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <Label>Permissions</Label>
            <OptionSelect
              label="Permissions"
              value={runtimeMode}
              disabled={launching}
              options={runtimeModeOptions.map((value) => ({
                value,
                label: runtimeModeConfig[value].label,
              }))}
              onChange={setPickedRuntimeMode}
            />
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

export function KanbanStartAgentDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && props.onClose()}>
      <DialogPopup className="max-w-md">
        <LaunchForm {...props} />
      </DialogPopup>
    </Dialog>
  );
}
