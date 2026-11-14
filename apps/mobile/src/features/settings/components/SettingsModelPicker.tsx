import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useMemo } from "react";

import {
  buildModelOptions,
  groupByProvider,
  type ModelOption,
  withInstanceName,
} from "../../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../../lib/providerOptions";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { ThreadSettingsPickerScreen } from "../../threads/ThreadSettingsSheet";

const sameModel = (option: ModelOption, selection: ModelSelection) =>
  option.selection.instanceId === selection.instanceId &&
  option.selection.model === selection.model;

/** A model's display name ("Claude Opus 5.5 · Beyond" when ambiguous); an unlisted model reads from its slug. */
export function modelDisplayName(options: ReadonlyArray<ModelOption>, selection: ModelSelection) {
  const option = options.find((candidate) => sameModel(candidate, selection));
  return withInstanceName(
    option && option.label !== selection.model
      ? option.label
      : formatModelSlugName(selection.model),
    option,
  );
}

/** A Settings model picker over one environment's models, with effort for the picked one. */
export function SettingsModelPicker(props: {
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly selected: ModelSelection | null;
  readonly onPick: (selection: ModelSelection) => void;
  readonly onClose: () => void;
}) {
  const { selected, projectId } = props;
  const config = useEnvironmentServerConfig(props.environmentId);
  const models = useMemo(
    () => buildModelOptions(config, selected, undefined, projectId),
    [config, selected, projectId],
  );
  const providerGroups = useMemo(() => groupByProvider(models), [models]);
  const capabilities =
    selected === null
      ? undefined
      : models.find((option) => sameModel(option, selected))?.capabilities;
  const optionDescriptors = useMemo(
    () => resolveProviderOptionDescriptors({ capabilities, selections: selected?.options }),
    [capabilities, selected?.options],
  );
  return (
    <ThreadSettingsPickerScreen
      title={props.title}
      environmentId={props.environmentId}
      projectId={projectId}
      providerGroups={providerGroups}
      selectedModel={selected}
      prompt=""
      onPromptChange={() => {}}
      onSelectModel={(option) => props.onPick(option.selection)}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={(options) => {
        if (selected) props.onPick({ ...selected, options });
      }}
      runtimeMode="full-access"
      onUpdateRuntimeMode={() => {}}
      runtimeHidden
      onClose={props.onClose}
    />
  );
}
