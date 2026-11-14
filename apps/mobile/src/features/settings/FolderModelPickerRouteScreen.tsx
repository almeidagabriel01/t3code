import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { upsertFolderModelDefault } from "@t3tools/shared/serverSettings";
import { useRef } from "react";

import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsModelPicker } from "./components/SettingsModelPicker";

export type FolderModelPickerParams = {
  readonly environmentId: EnvironmentId;
  readonly folder: string;
};

/** Picks the model for the folder typed one screen back; the rule is saved and both screens close. */
export function FolderModelPickerRouteScreen({
  route,
}: StaticScreenProps<FolderModelPickerParams>) {
  const { environmentId, folder } = route.params;
  const navigation = useNavigation();
  const picked = useRef<ModelSelection | null>(null);
  const config = useEnvironmentServerConfig(environmentId);
  const save = useAtomCommand(serverEnvironment.updateSettings, "folder model update");
  const rules = config?.settings.folderModelDefaults ?? [];
  return (
    <SettingsModelPicker
      title="Folder model"
      environmentId={environmentId}
      projectId={null}
      selected={null}
      onPick={(selection) => {
        picked.current = selection;
      }}
      // Save calls onSelectModel, then onClose; a picked model also leaves the folder step.
      onClose={() => {
        const selection = picked.current;
        navigation.dispatch(StackActions.pop(selection === null ? 1 : 2));
        if (selection !== null) {
          void save({
            environmentId,
            input: {
              patch: { folderModelDefaults: upsertFolderModelDefault(rules, folder, selection) },
            },
          });
        }
      }}
    />
  );
}
