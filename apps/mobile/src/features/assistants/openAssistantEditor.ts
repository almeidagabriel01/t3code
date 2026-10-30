import { useNavigation } from "@react-navigation/native";
import type { Assistant, EnvironmentId } from "@t3tools/contracts";

import { startAssistantEditor } from "./assistantDraft";

/** Opens the create/edit screen from Home, the thread menu, the palette or Settings. */
export function useOpenAssistantEditor() {
  const navigation = useNavigation();
  return (environmentId: EnvironmentId, assistant: Assistant | null) => {
    startAssistantEditor(environmentId, assistant);
    navigation.navigate("SettingsAssistantEdit");
  };
}
