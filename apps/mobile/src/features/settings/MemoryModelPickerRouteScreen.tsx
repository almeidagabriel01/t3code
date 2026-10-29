import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { resolveMemoryModelSelection } from "@t3tools/shared/serverSettings";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";

export type MemoryModelPickerParams = { readonly environmentId: EnvironmentId };

/** Picks the dedicated memory model; each choice saves to the environment's settings. */
export function MemoryModelPickerRouteScreen({
  route,
}: StaticScreenProps<MemoryModelPickerParams>) {
  const { environmentId } = route.params;
  const navigation = useNavigation();
  const config = useEnvironmentServerConfig(environmentId);
  const save = useAtomCommand(serverEnvironment.updateSettings, "memory model update");
  const selected = config ? resolveMemoryModelSelection(config.settings, config.providers) : null;
  const models = useMemo(
    () => buildModelOptions(config, selected, undefined, null),
    [config, selected],
  );
  const providerGroups = useMemo(() => groupByProvider(models), [models]);
  const selectedOption = models.find(
    (option) =>
      option.selection.instanceId === selected?.instanceId &&
      option.selection.model === selected.model,
  );
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: selectedOption?.capabilities,
        selections: selected?.options,
      }),
    [selectedOption?.capabilities, selected?.options],
  );
  return (
    <ThreadSettingsPickerScreen
      environmentId={environmentId}
      projectId={null}
      providerGroups={providerGroups}
      selectedModel={selected}
      prompt=""
      onPromptChange={() => {}}
      onSelectModel={(option) =>
        void save({ environmentId, input: { patch: { memoryModelSelection: option.selection } } })
      }
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={(options) => {
        if (selected)
          void save({
            environmentId,
            input: { patch: { memoryModelSelection: { ...selected, options } } },
          });
      }}
      runtimeMode="full-access"
      onUpdateRuntimeMode={() => {}}
      runtimeHidden
      onClose={() => navigation.goBack()}
    />
  );
}
