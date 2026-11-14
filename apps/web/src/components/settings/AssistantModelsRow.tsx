import type {
  AssistantId,
  ModelSelection,
  ProviderInstanceId,
  UnifiedSettings,
} from "@t3tools/contracts";
import { createModelSelection, formatModelSlugName } from "@t3tools/shared/model";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { IconAction, modelPickerProps, type PickerProps } from "./FallbackModelsRow";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";

type Providers = Parameters<typeof modelPickerProps>[2];

/**
 * The model and effort pickers for one selection, as the project's own model row draws them.
 * `composer` draws them as the composer's compact controls instead.
 */
export function SelectionPicker(
  props: PickerProps & {
    readonly settings: UnifiedSettings;
    readonly providers: Providers;
    readonly selection: ModelSelection;
    readonly label: string;
    readonly disabled: boolean;
    readonly composer?: boolean;
    /** Where the value comes from, for the tooltip and screen readers. */
    readonly detail?: string;
    readonly onChange: (selection: ModelSelection) => void;
  },
) {
  const { selection } = props;
  const entry = props.instanceEntries.find((item) => item.instanceId === selection.instanceId);
  return (
    <div
      className={
        props.composer
          ? "flex min-w-0 items-center gap-1"
          : "flex min-w-0 flex-wrap items-center gap-1.5"
      }
    >
      <ProviderModelPicker
        {...modelPickerProps(props, props.settings, props.providers, selection)}
        {...(props.composer ? { size: "xs" as const, compact: true, triggerClassName: "" } : {})}
        triggerAriaLabel={props.label}
        {...(props.detail === undefined ? {} : { triggerDetail: props.detail })}
        // A provider that is gone or off cannot name its model; the slug still reads cleanly.
        {...(entry ? {} : { triggerLabel: formatModelSlugName(selection.model) })}
        disabled={props.disabled}
        onInstanceModelChange={(instanceId, model) =>
          props.onChange(createModelSelection(instanceId, model))
        }
      />
      {entry ? (
        <TraitsPicker
          provider={entry.driverKind}
          models={entry.models}
          model={selection.model}
          modelOptions={selection.options ?? []}
          allowPromptInjectedEffort={false}
          disabled={props.disabled}
          {...(props.composer
            ? { size: "xs" as const }
            : { triggerClassName: SETTINGS_PICKER_TRIGGER_CLASSNAME })}
          onModelOptionsChange={(options) =>
            props.onChange(createModelSelection(selection.instanceId, selection.model, options))
          }
        />
      ) : null}
    </div>
  );
}

/** Assistants that start new threads in this project on their own model instead of the project's. */
export function AssistantModelsRow(
  props: PickerProps & {
    readonly settings: UnifiedSettings;
    readonly providers: Providers;
    /** The model a new exception starts with. */
    readonly anchor: ModelSelection | null;
    readonly selections: Readonly<Record<string, ModelSelection>>;
    /** Active assistants, offered for a new exception; archived ones only name their rows. */
    readonly assistants: ReadonlyArray<{ readonly id: AssistantId; readonly name: string }>;
    readonly archivedAssistants: ReadonlyArray<{ readonly id: AssistantId; readonly name: string }>;
    /** False when this connection may not change settings. */
    readonly canWrite: boolean;
    readonly save: (
      assistantId: AssistantId,
      selection: ModelSelection | null,
      onFailed: (message: string) => void,
    ) => void;
  },
) {
  const { anchor, selections, assistants } = props;
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pickedAssistant, setPickedAssistant] = useState<AssistantId | null>(null);
  const [pickedModel, setPickedModel] = useState<ModelSelection | null>(null);
  const draftModel = pickedModel ?? anchor;
  const nameOf = (id: string) =>
    [...assistants, ...props.archivedAssistants].find((assistant) => assistant.id === id)?.name ??
    "Removed assistant";
  const rows = Object.entries(selections)
    .map(([id, selection]) => ({ id: id as AssistantId, name: nameOf(id), selection }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const available = assistants.filter((assistant) => !Object.hasOwn(selections, assistant.id));
  const disabledReason = (selection: ModelSelection) =>
    props.getModelDisabledReason?.(selection.instanceId as ProviderInstanceId, selection.model) ??
    null;
  const save = (assistantId: AssistantId, selection: ModelSelection | null) => {
    const reason = selection === null ? null : disabledReason(selection);
    if (reason !== null) return setError(reason);
    setError(null);
    props.save(assistantId, selection, setError);
  };
  const closeForm = () => {
    setAdding(false);
    setPickedAssistant(null);
    setPickedModel(null);
  };

  return (
    <SettingsRow
      id="assistant-models"
      title="Model by assistant"
      description="These assistants start new threads in this project on their own model."
      control={
        anchor && !adding ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!props.canWrite || available.length === 0}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            Add assistant
          </Button>
        ) : null
      }
    >
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-1.5 pt-2 pb-2">
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-24 flex-1 truncate text-sm text-foreground">{row.name}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <SelectionPicker
                  {...props}
                  selection={row.selection}
                  label={`Model for ${row.name}`}
                  disabled={!props.canWrite}
                  onChange={(selection) => save(row.id, selection)}
                />
                <IconAction
                  label={`Remove ${row.name}`}
                  disabled={!props.canWrite}
                  onClick={() => save(row.id, null)}
                >
                  <Trash2Icon />
                </IconAction>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="pb-2 text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      {adding && draftModel ? (
        <form
          className="flex flex-col gap-3 pt-2 pb-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pickedAssistant === null) return;
            save(pickedAssistant, draftModel);
            closeForm();
          }}
        >
          <div className="flex flex-col items-start gap-1.5">
            <Label htmlFor="assistant-models-assistant">Assistant</Label>
            <Select
              value={pickedAssistant}
              onValueChange={(value) => setPickedAssistant(value as AssistantId | null)}
            >
              <SelectTrigger id="assistant-models-assistant" size="sm" aria-label="Assistant">
                <SelectValue>
                  {(value: string | null) => (value === null ? "Choose…" : nameOf(value))}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {available.map((assistant) => (
                  <SelectItem key={assistant.id} value={assistant.id}>
                    {assistant.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="flex flex-col items-start gap-1.5">
            <Label>Model</Label>
            <SelectionPicker
              {...props}
              selection={draftModel}
              label="Model for the new assistant"
              disabled={!props.canWrite}
              onChange={setPickedModel}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={closeForm}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pickedAssistant === null}>
              Add
            </Button>
          </div>
        </form>
      ) : null}
    </SettingsRow>
  );
}
