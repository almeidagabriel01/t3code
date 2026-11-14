import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { SelectionPicker } from "../settings/AssistantModelsRow";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { useScopedDefaultModel } from "../settings/useScopedModelAvailability";
import {
  useScopedSettingSource,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "../settings/useScopedSettings";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";

const SOURCE_DETAIL = {
  project: "Set for this project",
  folder: "From a folder rule",
  "t3.json": "From the repository's t3.json",
  environment: "Environment default",
  mixed: "Mixed",
} as const;

/**
 * The settings scope of exactly one project checkout, so the settings hooks read and write that
 * project's overrides from outside the Settings page. Renders nothing for an unknown project.
 */
function GroupProjectScope(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly children: ReactNode;
}) {
  const groups = useSettingsProjectGroups();
  const group = groups.find((candidate) =>
    candidate.memberProjects.some(
      (member) => member.environmentId === props.environmentId && member.id === props.projectId,
    ),
  );
  const member = group?.memberProjects.find(
    (candidate) =>
      candidate.environmentId === props.environmentId && candidate.id === props.projectId,
  );
  if (group === undefined || member === undefined) return null;
  return (
    <SettingsScopeProvider
      search={{
        project: group.projectKey,
        machine: props.environmentId,
        checkout: member.physicalProjectKey,
      }}
      onChange={() => {}}
    >
      {props.children}
    </SettingsScopeProvider>
  );
}

function ProjectModelPicker(props: {
  readonly projectLabel: string;
  readonly disabled: boolean;
  readonly onError: (message: string | null) => void;
}) {
  const { settings, representative, providers, selection, entries, modelDisabledReason } =
    useScopedDefaultModel();
  const source = useScopedSettingSource(["defaultModelSelection"]);
  const canWrite = useScopedSettingsWriteAllowed();
  const update = useUpdateScopedSettings();
  if (selection === null) return null;
  const save = (value: ModelSelection) => {
    const reason = modelDisabledReason(value.instanceId, value.model);
    if (reason !== null) return props.onError(reason);
    props.onError(null);
    update({ defaultModelSelection: value }, { onFailed: props.onError });
  };
  return (
    <SelectionPicker
      composer
      settings={settings}
      providers={providers}
      selection={selection}
      label={`Model for ${props.projectLabel}`}
      detail={SOURCE_DETAIL[source]}
      disabled={props.disabled || !canWrite}
      environmentId={representative?.environmentId ?? null}
      instanceEntries={entries}
      getModelDisabledReason={modelDisabledReason}
      onChange={save}
    />
  );
}

/** The model and effort new work in the project starts on; a change saves the project's default. */
export function GroupProjectModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  readonly disabled: boolean;
  readonly onError: (message: string | null) => void;
}) {
  return (
    <GroupProjectScope environmentId={props.environmentId} projectId={props.projectId}>
      <ProjectModelPicker
        projectLabel={props.projectLabel}
        disabled={props.disabled}
        onError={props.onError}
      />
    </GroupProjectScope>
  );
}
