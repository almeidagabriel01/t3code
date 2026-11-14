import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { ModelSelection } from "@t3tools/contracts";
import { useMemo } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { updateAssistantDraft } from "./assistantDraft";
import { useAssistantEditor } from "./useAssistantEditor";

export type AssistantModelPickerParams = {
  /** Picks the assistant's own default model instead of its conversation's. */
  readonly default?: boolean;
};

/** Picks the assistant's model into the open form; nothing is saved until the form is. */
export function AssistantModelPickerRouteScreen({
  route,
}: StaticScreenProps<AssistantModelPickerParams | undefined>) {
  const navigation = useNavigation();
  const pickingDefault = route.params?.default === true;
  const editorState = useAssistantEditor();
  const { editor, config, effectiveProject } = editorState;
  const modelSelection = pickingDefault
    ? (editorState.defaultModelSelection ?? editorState.userDefaultModel)
    : editorState.modelSelection;
  const pick = (selection: ModelSelection) =>
    updateAssistantDraft(
      pickingDefault ? { defaultModelSelection: selection } : { modelSelection: selection },
    );
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
      title={pickingDefault ? "Default model" : "Model and effort"}
      environmentId={editor.environmentId}
      projectId={projectId}
      providerGroups={providerGroups}
      selectedModel={modelSelection}
      prompt=""
      onPromptChange={() => {}}
      onSelectModel={(option) => pick(option.selection)}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={(options) => {
        if (modelSelection) pick({ ...modelSelection, options });
      }}
      runtimeMode="full-access"
      onUpdateRuntimeMode={() => {}}
      runtimeHidden
      onClose={() => navigation.goBack()}
    />
  );
}
