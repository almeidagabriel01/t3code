import type { Assistant, EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { useEnvironments } from "../../state/environments";
import { SelectionPicker } from "../settings/AssistantModelsRow";
import { SettingsScopeProvider, useSettingsScope } from "../settings/SettingsScopeContext";
import { useScopedDefaultModel } from "../settings/useScopedModelAvailability";
import {
  useScopedSettingSource,
  useScopedSettingsWriteAllowed,
  useUpdateProjectAssistantModel,
  useUpdateScopedSettings,
} from "../settings/useScopedSettings";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";

const SOURCE_DETAIL = {
  project: "Set for this project",
  folder: "From a folder rule",
  "t3.json": "From the repository's t3.json",
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
  readonly teamDefault: ModelSelection | null;
  readonly disabled: boolean;
  readonly onError: (message: string | null) => void;
}) {
  const { settings, representative, providers, selection, entries, modelDisabledReason } =
    useScopedDefaultModel();
  const source = useScopedSettingSource(["defaultModelSelection"]);
  const canWrite = useScopedSettingsWriteAllowed();
  const update = useUpdateScopedSettings();
  // Without its own default the project's requests run on the group's, else each member's own.
  const inherited = source === "environment";
  const shown = inherited ? (props.teamDefault ?? selection) : selection;
  if (shown === null) return null;
  const detail = !inherited
    ? SOURCE_DETAIL[source]
    : props.teamDefault === null
      ? "Not set: each member uses its own model"
      : "Group default";
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
      selection={shown}
      label={`Model for ${props.projectLabel}`}
      detail={detail}
      {...(inherited && props.teamDefault === null ? { placeholder: "Members' models" } : {})}
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
  /** The group's default, which the project's requests run on when it has none of its own. */
  readonly teamDefault: ModelSelection | null;
  readonly disabled: boolean;
  readonly onError: (message: string | null) => void;
}) {
  return (
    <GroupProjectScope environmentId={props.environmentId} projectId={props.projectId}>
      <ProjectModelPicker
        projectLabel={props.projectLabel}
        teamDefault={props.teamDefault}
        disabled={props.disabled}
        onError={props.onError}
      />
    </GroupProjectScope>
  );
}

/** The members whose new work in the project runs on their own model, by assistant id. */
export function useMemberModelExceptions(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): Readonly<Record<string, ModelSelection>> {
  const { environments } = useEnvironments();
  if (projectId === null) return {};
  return (
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.settings.projectSettingsOverrides[projectId]?.assistantModelSelections ?? {}
  );
}

function MemberModelFields(props: { readonly member: Assistant }) {
  const { member } = props;
  const { target } = useSettingsScope();
  const { settings, representative, providers, selection, entries, modelDisabledReason } =
    useScopedDefaultModel();
  const canWrite = useScopedSettingsWriteAllowed();
  const update = useUpdateProjectAssistantModel();
  const [error, setError] = useState<string | null>(null);
  const exception =
    target?.projectId == null
      ? undefined
      : representative?.serverConfig?.settings.projectSettingsOverrides[target.projectId]
          ?.assistantModelSelections?.[member.id];
  const shown = exception ?? selection;
  const save = (value: ModelSelection | null) => {
    const reason = value === null ? null : modelDisabledReason(value.instanceId, value.model);
    if (reason !== null) return setError(reason);
    setError(null);
    if (representative) update(representative.environmentId, member.id, value, setError);
  };
  return (
    <>
      <DialogPanel>
        <div className="flex flex-col items-start gap-1.5">
          <Label>Model</Label>
          {shown ? (
            <SelectionPicker
              settings={settings}
              providers={providers}
              selection={shown}
              label={`Model for ${member.name}`}
              disabled={!canWrite}
              environmentId={representative?.environmentId ?? null}
              instanceEntries={entries}
              getModelDisabledReason={modelDisabledReason}
              onChange={save}
            />
          ) : (
            <span className="text-sm text-muted-foreground">No providers available</span>
          )}
          <p className="text-xs text-muted-foreground">
            {exception
              ? `Set for ${member.name} in this project.`
              : `No exception for ${member.name} in this project.`}
          </p>
          {error === null ? null : (
            <p role="alert" className="text-xs text-destructive-foreground">
              {error}
            </p>
          )}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        {exception ? (
          <Button variant="destructive-outline" disabled={!canWrite} onClick={() => save(null)}>
            Remove exception
          </Button>
        ) : null}
        <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
      </DialogFooter>
    </>
  );
}

/** One member's own model for new work in the project, ahead of the project's model. */
export function MemberProjectModelDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  readonly member: Assistant;
  readonly onClose: () => void;
}) {
  const { member } = props;
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {member.name}'s model in {props.projectLabel}
          </DialogTitle>
          <DialogDescription>
            New work for {member.name} in {props.projectLabel} starts on this model instead of the
            project's.
          </DialogDescription>
        </DialogHeader>
        <GroupProjectScope environmentId={props.environmentId} projectId={props.projectId}>
          <MemberModelFields member={member} />
        </GroupProjectScope>
      </DialogPopup>
    </Dialog>
  );
}
