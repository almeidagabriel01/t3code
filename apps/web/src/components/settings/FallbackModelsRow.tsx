import {
  MAX_FALLBACK_MODEL_SELECTIONS,
  type ModelSelection,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  addFallbackModel,
  fallbackModelsPatch,
  moveFallbackModel,
  removeFallbackModel,
  replaceFallbackModel,
} from "@t3tools/shared/serverSettings";
import { fallbackModelSelectionsOf } from "@t3tools/shared/usageLimits";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import type { useUpdateScopedSettings } from "./useScopedSettings";

type PickerProps = Pick<
  ComponentProps<typeof ProviderModelPicker>,
  "environmentId" | "instanceEntries" | "getModelDisabledReason"
>;

function IconAction(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.label}
            disabled={props.disabled ?? false}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** The ordered chain of models new threads fall back to when the default model's provider is out of usage. */
export function FallbackModelsRow(
  props: PickerProps & {
    readonly settings: UnifiedSettings;
    readonly providers: Parameters<typeof getCustomModelOptionsByInstance>[1];
    readonly update: ReturnType<typeof useUpdateScopedSettings>;
    readonly mixed: boolean;
    /** Opens the Add picker on the default model's provider. */
    readonly anchor: ModelSelection | null;
  },
) {
  const { settings, providers, update, mixed, anchor } = props;
  const list = fallbackModelSelectionsOf(settings);
  const save = (next: ReadonlyArray<ModelSelection>) => update(fallbackModelsPatch(next));
  const choose = (instanceId: ModelSelection["instanceId"], model: string) => {
    const reason = props.getModelDisabledReason?.(instanceId, model) ?? null;
    if (reason)
      toastManager.add({ type: "error", title: "Fallback model not saved", description: reason });
    return reason === null;
  };
  const pickerProps = (selection: ModelSelection) => ({
    environmentId: props.environmentId,
    activeInstanceId: selection.instanceId,
    model: selection.model,
    lockedProvider: null,
    instanceEntries: props.instanceEntries,
    modelOptionsByInstance: getCustomModelOptionsByInstance(
      settings,
      providers,
      selection.instanceId,
      selection.model,
    ),
    triggerClassName: SETTINGS_PICKER_TRIGGER_CLASSNAME,
    ...(props.getModelDisabledReason
      ? { getModelDisabledReason: props.getModelDisabledReason }
      : {}),
  });

  return (
    <SettingsRow
      serverScoped
      settingKeys={["fallbackModelSelections", "fallbackModelSelection"]}
      mixed={mixed}
      id="fallback-model"
      title="Fallback models"
      description={`Tried in order for new threads when the default model's provider is out of usage. Up to ${MAX_FALLBACK_MODEL_SELECTIONS}.`}
      resetAction={
        mixed || list.length > 0 ? (
          <SettingResetButton label="fallback models" onClick={() => save([])} />
        ) : null
      }
      control={
        anchor && list.length < MAX_FALLBACK_MODEL_SELECTIONS && !mixed ? (
          <ProviderModelPicker
            {...pickerProps(anchor)}
            triggerLabel="Add model"
            triggerAriaLabel="Add fallback model"
            onInstanceModelChange={(instanceId, model) => {
              if (choose(instanceId, model))
                save(addFallbackModel(list, createModelSelection(instanceId, model)));
            }}
          />
        ) : mixed ? (
          <span className="text-sm text-muted-foreground">Mixed</span>
        ) : null
      }
    >
      {list.length > 0 && !mixed ? (
        <ol className="flex flex-col gap-1.5 pt-2 pb-2">
          {list.map((entry, index) => (
            <li
              key={`${entry.instanceId}:${entry.model}`}
              className="flex min-w-0 items-center gap-2"
            >
              <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <ProviderModelPicker
                {...pickerProps(entry)}
                triggerAriaLabel={`Fallback model ${index + 1}`}
                onInstanceModelChange={(instanceId, model) => {
                  if (choose(instanceId, model))
                    save(
                      replaceFallbackModel(list, index, createModelSelection(instanceId, model)),
                    );
                }}
              />
              <div className="ml-auto flex shrink-0 items-center">
                <IconAction
                  label="Move up"
                  disabled={index === 0}
                  onClick={() => save(moveFallbackModel(list, index, -1))}
                >
                  <ChevronUpIcon />
                </IconAction>
                <IconAction
                  label="Move down"
                  disabled={index === list.length - 1}
                  onClick={() => save(moveFallbackModel(list, index, 1))}
                >
                  <ChevronDownIcon />
                </IconAction>
                <IconAction label="Remove" onClick={() => save(removeFallbackModel(list, index))}>
                  <XIcon />
                </IconAction>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </SettingsRow>
  );
}
