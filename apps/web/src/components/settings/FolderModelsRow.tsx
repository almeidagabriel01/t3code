import { type ModelSelection, type UnifiedSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { upsertFolderModelDefault } from "@t3tools/shared/serverSettings";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { IconAction, modelPickerProps, type PickerProps } from "./FallbackModelsRow";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import type { useUpdateScopedSettings } from "./useScopedSettings";

/** Projects inside a folder start new threads with that folder's model. */
export function FolderModelsRow(
  props: PickerProps & {
    readonly settings: UnifiedSettings;
    readonly providers: Parameters<typeof modelPickerProps>[2];
    readonly update: ReturnType<typeof useUpdateScopedSettings>;
    readonly mixed: boolean;
    /** The model a new rule starts with. */
    readonly anchor: ModelSelection | null;
  },
) {
  const { settings, providers, update, mixed, anchor } = props;
  const list = settings.folderModelDefaults;
  const [adding, setAdding] = useState(false);
  const [folder, setFolder] = useState("");
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const draftModel = picked ?? anchor;
  const choose = (instanceId: ModelSelection["instanceId"], model: string) => {
    const reason = props.getModelDisabledReason?.(instanceId, model) ?? null;
    if (reason)
      toastManager.add({ type: "error", title: "Folder model not saved", description: reason });
    return reason === null;
  };
  const closeForm = () => {
    setAdding(false);
    setFolder("");
    setPicked(null);
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["folderModelDefaults"]}
      mixed={mixed}
      id="folder-models"
      title="Model by folder"
      description="Projects inside a folder start new threads with its model; a project's own setting still wins."
      resetAction={
        mixed || list.length > 0 ? (
          <SettingResetButton
            label="model by folder"
            onClick={() => update({ folderModelDefaults: [] })}
          />
        ) : null
      }
      control={
        mixed ? (
          <span className="text-sm text-muted-foreground">Mixed</span>
        ) : anchor && !adding ? (
          <Button
            size="sm"
            variant="outline"
            className="cursor-pointer"
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            Add folder
          </Button>
        ) : null
      }
    >
      {list.length > 0 && !mixed ? (
        <ul className="flex flex-col gap-1.5 pt-2 pb-2">
          {list.map((rule, index) => (
            <li key={rule.folder} className="flex min-w-0 items-center gap-2">
              <StartTruncatedPath path={rule.folder} className="flex-1 text-sm text-foreground" />
              <ProviderModelPicker
                {...modelPickerProps(props, settings, providers, rule.modelSelection)}
                triggerAriaLabel={`Model for ${rule.folder}`}
                onInstanceModelChange={(instanceId, model) => {
                  if (choose(instanceId, model))
                    update({
                      folderModelDefaults: upsertFolderModelDefault(
                        list,
                        rule.folder,
                        createModelSelection(instanceId, model),
                      ),
                    });
                }}
              />
              <IconAction
                label={`Remove ${rule.folder}`}
                onClick={() =>
                  update({ folderModelDefaults: list.filter((_, at) => at !== index) })
                }
              >
                <XIcon />
              </IconAction>
            </li>
          ))}
        </ul>
      ) : null}
      {adding && draftModel && !mixed ? (
        <form
          className="flex flex-col gap-3 pt-2 pb-3"
          onSubmit={(event) => {
            event.preventDefault();
            update({ folderModelDefaults: upsertFolderModelDefault(list, folder, draftModel) });
            closeForm();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="folder-models-path">Folder</Label>
            <Input
              id="folder-models-path"
              value={folder}
              placeholder="~/projects/work"
              autoFocus
              onChange={(event) => setFolder(event.target.value)}
            />
          </div>
          <div className="flex flex-col items-start gap-1.5">
            <Label>Model</Label>
            <ProviderModelPicker
              {...modelPickerProps(props, settings, providers, draftModel)}
              triggerAriaLabel="Model for the new folder"
              onInstanceModelChange={(instanceId, model) => {
                if (choose(instanceId, model)) setPicked(createModelSelection(instanceId, model));
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={closeForm}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={folder.trim() === ""}>
              Add
            </Button>
          </div>
        </form>
      ) : null}
    </SettingsRow>
  );
}
