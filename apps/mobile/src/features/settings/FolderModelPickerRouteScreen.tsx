import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { upsertFolderModelDefault } from "@t3tools/shared/serverSettings";
import { useMemo } from "react";

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
        void save({
          environmentId,
          input: {
            patch: {
              folderModelDefaults: upsertFolderModelDefault(rules, folder, option.selection),
            },
          },
        });
        navigation.dispatch(StackActions.pop(2));
      }}
      optionDescriptors={[]}
      onUpdateOptionSelections={() => {}}
      runtimeMode="full-access"
      onUpdateRuntimeMode={() => {}}
      runtimeHidden
      onClose={() => navigation.goBack()}
    />
  );
}
