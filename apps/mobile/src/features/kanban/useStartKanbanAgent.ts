import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import {
  kanbanCardContextRecord,
  kanbanStartText,
} from "@t3tools/client-runtime/state/kanbanLogic";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type EnvironmentId,
  type KanbanCard,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { serializeComposerMessageForServer } from "../../lib/composerContext";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useStickyComposerModelSelection } from "../../state/use-composer-drafts";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";
import { useKanbanActions } from "./useKanbanActions";

/** Same as web "Start with agent": a new thread in the card's project whose first message carries the card, linked to it. */
export function useStartKanbanAgent(
  environmentId: EnvironmentId,
  board: KanbanBoardState,
  card: KanbanCard,
) {
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === board.projectId,
  );
  const config = useEnvironmentServerConfig(environmentId);
  const sticky = useStickyComposerModelSelection();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "kanban start with agent");
  const actions = useKanbanActions(environmentId);
  const openThread = useOpenLinkedThread();
  const [starting, setStarting] = useState(false);

  const start = async () => {
    if (project === undefined || starting) return;
    const settings = resolveProjectSettings(
      config?.settings ?? DEFAULT_SERVER_SETTINGS,
      project.id,
      project,
    ).settings;
    const projectDefault = resolveDefaultableModelSelection(
      config,
      settings.defaultModelSelection,
      project.id,
    );
    const stickySelection = resolveDefaultableModelSelection(config, sticky, project.id);
    const modelSelection = resolveNewTaskModelSelection({
      draftSelection: null,
      projectDefaultSelection: projectDefault,
      stickySelection,
      modelOptions: buildModelOptions(
        config,
        projectDefault ?? stickySelection,
        undefined,
        project.id,
      ),
    });
    if (modelSelection === null) {
      Dialog.alert("No model available", "Connect a provider in this environment first.");
      return;
    }
    const record = kanbanCardContextRecord(card, board);
    const reference = formatComposerContextReference({
      kind: "kanban-card",
      contextId: record.contextId,
      label: record.label,
    });
    const metadata = makeTurnCommandMetadata();
    setStarting(true);
    const result = await startTurn({
      environmentId,
      input: buildProjectThreadStartTurnInput({
        ...metadata,
        projectId: project.id,
        projectCwd: project.workspaceRoot,
        titleText: `#${card.number} ${card.title}`,
        ...serializeComposerMessageForServer(
          kanbanStartText(
            reference,
            card.parentCardId === null ? undefined : board.cards.get(card.parentCardId),
          ),
          { version: 1, records: [record] },
        ),
        uploadedAttachments: [],
        modelSelection,
        runtimeMode: settings.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
        worktreeBranchName: "",
      }),
    });
    setStarting(false);
    if (result._tag !== "Success") return;
    const threadId = metadata.threadId;
    await actions.linkCardThread({ cardId: card.id, threadId: ThreadId.make(threadId) });
    openThread({ environmentId, threadId });
  };
  return { start, starting, ready: project !== undefined };
}
