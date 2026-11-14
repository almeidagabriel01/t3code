import { useAtomValue } from "@effect/atom-react";
import {
  ALL_PROJECTS,
  homeAfterPick,
  projectPickerRows,
} from "@t3tools/client-runtime/assistantSections";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAssistantHomeProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { DEFAULT_AUTONOMY_SETTINGS, type ModelSelection } from "@t3tools/contracts";

import { buildModelOptions, modelWithEffortLabel } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects, useThreadShell } from "../../state/entities";
import { scheduledTaskDefaultModel } from "../settings/scheduledTaskDraft";
import { assistantEditorAtom } from "./assistantDraft";

export function assistantProjectName(project: EnvironmentProject): string {
  return isAssistantHomeProject(project) ? "All projects" : project.title;
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
      .filter((project) => !isAssistantHomeProject(project))
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
  const labelOf = (selection: ModelSelection) =>
    modelWithEffortLabel(
      selection,
      buildModelOptions(config, selection, undefined, effectiveProject?.id ?? null).find(
        (option) =>
          option.selection.instanceId === selection.instanceId &&
          option.selection.model === selection.model,
      ),
    );
  const modelLabel = modelSelection === null ? null : labelOf(modelSelection);
  // Undefined on servers older than assistant default models, which then hide the field.
  const storedDefault = editor?.assistant?.defaultModelSelection;
  const defaultModelSelection =
    editor?.current.defaultModelSelection === undefined
      ? (storedDefault ?? null)
      : editor.current.defaultModelSelection;
  const userDefaultModel = scheduledTaskDefaultModel(config, null);
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
    supportsDefaultModel: storedDefault !== undefined,
    defaultModelSelection,
    defaultModelLabel: defaultModelSelection === null ? null : labelOf(defaultModelSelection),
    userDefaultModel,
    userDefaultModelLabel: userDefaultModel === null ? null : labelOf(userDefaultModel),
    globalAutonomy,
  };
}
