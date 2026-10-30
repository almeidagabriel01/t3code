import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { addFallbackModel, fallbackModelsPatch } from "@t3tools/shared/serverSettings";
import { fallbackModelSelectionsOf } from "@t3tools/shared/usageLimits";
import { useMemo } from "react";

import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";

export type FallbackModelPickerParams = { readonly environmentId: EnvironmentId };

/** Picks one more fallback model; the choice is appended to the environment's chain and saved. */
export function FallbackModelPickerRouteScreen({
  route,
}: StaticScreenProps<FallbackModelPickerParams>) {
  const { environmentId } = route.params;
  const navigation = useNavigation();
  const config = useEnvironmentServerConfig(environmentId);
  const save = useAtomCommand(serverEnvironment.updateSettings, "fallback models update");
  const chain = config ? fallbackModelSelectionsOf(config.settings) : [];
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
          input: { patch: fallbackModelsPatch(addFallbackModel(chain, option.selection)) },
        });
        navigation.goBack();
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
