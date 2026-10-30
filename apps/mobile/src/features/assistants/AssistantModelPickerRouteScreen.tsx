import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { updateAssistantDraft } from "./assistantDraft";
import { useAssistantEditor } from "./useAssistantEditor";

/** Picks the assistant's model into the open form; nothing is saved until the form is. */
export function AssistantModelPickerRouteScreen() {
  const navigation = useNavigation();
  const { editor, config, effectiveProject, modelSelection } = useAssistantEditor();
  const projectId = effectiveProject?.id ?? null;
  const models = useMemo(
    () => buildModelOptions(config, modelSelection, undefined, projectId),
    [config, modelSelection, projectId],
  );
  const providerGroups = useMemo(() => groupByProvider(models), [models]);
  const selectedOption = models.find(
    (option) =>
      option.selection.instanceId === modelSelection?.instanceId &&
      option.selection.model === modelSelection.model,
  );
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: selectedOption?.capabilities,
        selections: modelSelection?.options,
      }),
    [selectedOption?.capabilities, modelSelection?.options],
  );

  if (!editor) {
    return (
      <SettingsScreen title="Assistant">
        <Text className="p-5 text-base text-foreground-muted">Open an assistant form first.</Text>
      </SettingsScreen>
    );
  }

  return (
    <ThreadSettingsPickerScreen
      environmentId={editor.environmentId}
      projectId={projectId}
      providerGroups={providerGroups}
      selectedModel={modelSelection}
      prompt=""
      onPromptChange={() => {}}
      onSelectModel={(option) => updateAssistantDraft({ modelSelection: option.selection })}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={(options) => {
        if (modelSelection)
          updateAssistantDraft({ modelSelection: { ...modelSelection, options } });
      }}
      runtimeMode="full-access"
      onUpdateRuntimeMode={() => {}}
      runtimeHidden
      onClose={() => navigation.goBack()}
    />
  );
}
