import { useNavigation } from "@react-navigation/native";
import type { Assistant, EnvironmentId } from "@t3tools/contracts";

import { useAssistantEntries } from "../../state/assistants";
import { startAssistantEditor, type AssistantPreset } from "./assistantDraft";

/** Opens the create/edit screen from Home, the thread menu, the palette or Settings. */
export function useOpenAssistantEditor() {
  const navigation = useNavigation();
  const { active, archived } = useAssistantEntries();
  return (environmentId: EnvironmentId, assistant: Assistant | null, preset?: AssistantPreset) => {
    startAssistantEditor(environmentId, assistant, {
      ...preset,
      lookIndex: active.length + archived.length,
    });
    navigation.navigate("SettingsAssistantEdit");
  };
}
