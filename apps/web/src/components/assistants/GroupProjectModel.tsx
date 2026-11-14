import {
  type AssistantGroupTabKey,
  type AssistantGroupTabPick,
  assistantGroupComposerModel,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  type Assistant,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import {
  type ModelSelectionLayer,
  projectModelLayer,
  resolveModelSelection,
} from "@t3tools/shared/modelSelectionPrecedence";
import { RotateCcwIcon, XIcon } from "lucide-react";
import { formatModelSlugName } from "@t3tools/shared/model";
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
import { ComposerControl } from "../chat/ComposerControl";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { Badge } from "../ui/badge";
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
import { PopoverClose } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SOURCE_DETAIL = {
  project: "Set for this project",
  folder: "From a folder rule",
  "t3.json": "From the repository's t3.json",
  mixed: "Mixed",
} as const;

const INHERITED_LABEL: Partial<Record<ModelSelectionLayer, string>> = {
  project: "Project's model",
  team: "Group default",
  assistant: "Member's default",
  global: "Your default model",
};

/** The server skips a layer whose provider instance is off in the project; so does what we show. */
const usableIn =
  (
    settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0],
    projectId: ProjectId | null | undefined,
  ) =>
  (selection: ModelSelection) =>
    projectId == null ||
    resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId);

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

/** The composer's pick for the next message, which never saves a default. */
export interface GroupMessageModel {
  readonly pick: AssistantGroupTabPick<ModelSelection> | null;
  readonly tab: AssistantGroupTabKey | null;
  readonly onPick: (selection: ModelSelection | null) => void;
}

function ProjectModelPicker(props: {
  readonly projectLabel: string;
  readonly teamDefault: ModelSelection | null;
  readonly disabled: boolean;
  readonly onError: (message: string | null) => void;
  readonly message?: GroupMessageModel | undefined;
  readonly field?: boolean | undefined;
}) {
  const { message } = props;
  const { settings, representative, providers, selection, entries, modelDisabledReason } =
    useScopedDefaultModel();
  const { target } = useSettingsScope();
  const source = useScopedSettingSource(["defaultModelSelection"]);
  const canWrite = useScopedSettingsWriteAllowed();
  const update = useUpdateScopedSettings();
  const layers = {
    project: projectModelLayer(source, selection),
    team: props.teamDefault ?? undefined,
  };
  const fallback = layers.project ?? layers.team ?? selection;
  if (fallback === null) return null;
  const defaults = { ...layers, global: fallback };
  const isUsable = usableIn(settings, target?.projectId);
  // `global` means no project or group model applies: each member runs on its own.
  const { selection: resolved, layer } =
    message === undefined
      ? resolveModelSelection(defaults, isUsable)
      : assistantGroupComposerModel({
          ...message,
          defaults,
          isUsable,
          available: { settings, projectId: target?.projectId ?? null, providers },
        });
  const shown = layer === "global" ? (selection ?? fallback) : resolved;
  const back = resolveModelSelection(defaults, isUsable);
  const backEntry = entries.find((entry) => entry.instanceId === back.selection.instanceId);
  const backModel = backEntry?.models.find((model) => model.slug === back.selection.model);
  const backLabel =
    back.layer === "global"
      ? "Members' models"
      : backModel
        ? getTriggerDisplayModelName(backModel, backEntry?.driverKind)
        : formatModelSlugName(back.selection.model);
  const detail =
    layer === "message"
      ? "This message only"
      : layer === "global"
        ? "Not set: each member uses its own model"
        : layer === "team"
          ? "Group default"
          : SOURCE_DETAIL[source as keyof typeof SOURCE_DETAIL];
  const save = (value: ModelSelection) => {
    const reason = modelDisabledReason(value.instanceId, value.model);
    if (reason !== null) return props.onError(reason);
    props.onError(null);
    if (message !== undefined) return message.onPick(value);
    update({ defaultModelSelection: value }, { onFailed: props.onError });
  };
  const picker = (
    <SelectionPicker
      composer={message !== undefined}
      field={props.field === true}
      settings={settings}
      providers={providers}
      selection={shown}
      label={layer === "message" ? "Model for this message" : `Model for ${props.projectLabel}`}
      detail={detail}
      {...(layer === "global" ? { placeholder: "Members' models" } : {})}
      // A message's pick saves nothing, so it needs no right to change settings.
      disabled={props.disabled || (message === undefined && !canWrite)}
      environmentId={representative?.environmentId ?? null}
      instanceEntries={entries}
      getModelDisabledReason={modelDisabledReason}
      {...(message !== undefined && layer === "message"
        ? {
            footer: (
              <PopoverClose
                render={
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 border-t border-foreground/12 px-3 py-2 text-left text-sm outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
                onClick={() => message.onPick(null)}
              >
                <RotateCcwIcon className="size-4 text-muted-foreground" />
                Back to {backLabel}
              </PopoverClose>
            ),
          }
        : {})}
      onChange={save}
    />
  );
  if (message === undefined || layer !== "message") return picker;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {picker}
      <Tooltip>
        <TooltipTrigger render={<Badge variant="info" size="sm" className="shrink-0" />}>
          This message
        </TooltipTrigger>
        <TooltipPopup>
          The work of the message you send next runs on this model, for a new request all of it
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size="xs"
              aria-label={`Use ${props.projectLabel}'s model`}
              disabled={props.disabled}
              onClick={() => message.onPick(null)}
            />
          }
        >
          <XIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Back to {props.projectLabel}'s model</TooltipPopup>
      </Tooltip>
    </span>
  );
}

/**
 * The model and effort new work in the project starts on. With `message` it picks for the next
 * message only; without, a change saves the project's default.
 */
export function GroupProjectModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  /** The group's default where it holds in this project (`teamModelLayer`). */
  readonly teamDefault: ModelSelection | null;
  readonly disabled: boolean;
  readonly onError: (message: string | null) => void;
  readonly message?: GroupMessageModel;
  /** As a dialog's form field. */
  readonly field?: boolean;
}) {
  return (
    <GroupProjectScope environmentId={props.environmentId} projectId={props.projectId}>
      <ProjectModelPicker
        projectLabel={props.projectLabel}
        teamDefault={props.teamDefault}
        disabled={props.disabled}
        onError={props.onError}
        message={props.message}
        field={props.field}
      />
    </GroupProjectScope>
  );
}

/** The project's own default for new work, from the group chat; a message can still pick another. */
export function ProjectModelDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  readonly teamDefault: ModelSelection | null;
  readonly onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Model in {props.projectLabel}</DialogTitle>
          <DialogDescription>
            New work in {props.projectLabel} starts on this model. A message can still pick its own
            in the composer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col items-start gap-1.5">
            <Label>Model</Label>
            <GroupProjectModelPicker
              environmentId={props.environmentId}
              projectId={props.projectId}
              projectLabel={props.projectLabel}
              teamDefault={props.teamDefault}
              disabled={false}
              onError={setError}
              field
            />
            {error === null ? null : (
              <p role="alert" className="text-xs text-destructive-foreground">
                {error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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

function MemberModelFields(props: {
  readonly member: Assistant;
  readonly teamDefault: ModelSelection | null;
}) {
  const { member } = props;
  const { target } = useSettingsScope();
  const { settings, representative, providers, selection, entries, modelDisabledReason } =
    useScopedDefaultModel();
  const source = useScopedSettingSource(["defaultModelSelection"]);
  const canWrite = useScopedSettingsWriteAllowed();
  const update = useUpdateProjectAssistantModel();
  const [error, setError] = useState<string | null>(null);
  const exception =
    target?.projectId == null
      ? undefined
      : representative?.serverConfig?.settings.projectSettingsOverrides[target.projectId]
          ?.assistantModelSelections?.[member.id];
  const shown = exception ?? selection;
  // Without an exception the member runs on what comes next in line, not on the scope's default.
  const layers = {
    project: projectModelLayer(source, selection),
    team: props.teamDefault ?? undefined,
    assistant: member.defaultModelSelection ?? undefined,
  };
  const fallback = layers.project ?? layers.team ?? layers.assistant;
  const inherited =
    (fallback === undefined
      ? undefined
      : INHERITED_LABEL[
          resolveModelSelection(
            { ...layers, global: fallback },
            usableIn(settings, target?.projectId),
          ).layer
        ]) ?? "Your default model";
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
              field
              {...(exception ? {} : { placeholder: inherited })}
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
  /** The group's default, which the member runs on there when the project has none. */
  readonly teamDefault: ModelSelection | null;
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
          <MemberModelFields member={member} teamDefault={props.teamDefault} />
        </GroupProjectScope>
      </DialogPopup>
    </Dialog>
  );
}
