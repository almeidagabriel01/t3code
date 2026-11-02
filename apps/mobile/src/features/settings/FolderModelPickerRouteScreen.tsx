import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { upsertFolderModelDefault } from "@t3tools/shared/serverSettings";
import { useMemo, useRef } from "react";

import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";

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
  const models = useMemo(() => buildModelOptions(config, null, undefined, null), [config]);
  const providerGroups = useMemo(() => groupByProvider(models), [models]);
  return (
    <ThreadSettingsPickerScreen
      environmentId={environmentId}
      projectId={null}
      providerGroups={providerGroups}
      selectedModel={null}
      prompt=""
      onPromptChange={() => {}}
      onSelectModel={(option) => {
        picked.current = option.selection;
      }}
      optionDescriptors={[]}
      onUpdateOptionSelections={() => {}}
      runtimeMode="full-access"
      onUpdateRuntimeMode={() => {}}
      runtimeHidden
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
