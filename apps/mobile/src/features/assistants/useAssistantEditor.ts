import { useAtomValue } from "@effect/atom-react";
import {
  ALL_PROJECTS,
  homeAfterPick,
  projectPickerRows,
} from "@t3tools/client-runtime/assistantSections";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { DEFAULT_AUTONOMY_SETTINGS, type ModelSelection } from "@t3tools/contracts";

import { buildModelOptions, modelWithEffortLabel } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects, useThreadShell } from "../../state/entities";
import { scheduledTaskDefaultModel } from "../settings/scheduledTaskDraft";
import { assistantEditorAtom } from "./assistantDraft";

export function assistantProjectName(project: EnvironmentProject): string {
  return project.isScratch === true ? "All projects" : project.title;
}

/**
 * The open form with what it shows for the fields still unchosen: All projects, and the
 * conversation's current model (or the environment's default for a new assistant).
 */
export function useAssistantEditor() {
  const editor = useAtomValue(assistantEditorAtom);
  const environmentId = editor?.environmentId ?? null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const picked = editor?.current.projectIds ?? [ALL_PROJECTS];
  const pickerRows = projectPickerRows(
    projects
      .filter((project) => project.isScratch !== true)
      .map((project) => ({
        id: project.id,
        label: project.title,
        path: project.workspaceRoot,
      })),
  );
  // The home project: the current one while it stays picked. It sets the model and memory.
  const homeId =
    homeAfterPick<string>(editor?.assistant?.projectId ?? null, picked) ?? projects[0]?.id ?? null;
  const effectiveProject = projects.find((project) => project.id === homeId) ?? null;
  const config = useEnvironmentServerConfig(environmentId);
  const threadId = editor?.assistant?.threadId ?? null;
  const thread = useThreadShell(
    environmentId !== null && threadId !== null ? scopeThreadRef(environmentId, threadId) : null,
  );
  const modelSelection: ModelSelection | null =
    editor?.current.modelSelection ??
    thread?.modelSelection ??
    scheduledTaskDefaultModel(config, effectiveProject);
  const modelLabel =
    modelSelection === null
      ? null
      : modelWithEffortLabel(
          modelSelection,
          buildModelOptions(config, modelSelection, undefined, effectiveProject?.id ?? null).find(
            (option) =>
              option.selection.instanceId === modelSelection.instanceId &&
              option.selection.model === modelSelection.model,
          ),
        );
  const globalAutonomy = config?.settings.autonomy ?? DEFAULT_AUTONOMY_SETTINGS;
  return {
    editor,
    projects,
    picked,
    pickerRows,
    effectiveProject,
    config,
    modelSelection,
    modelLabel,
    globalAutonomy,
  };
}
