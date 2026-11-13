import { useNavigation } from "@react-navigation/native";
import type { AssistantId, AssistantTeamId, EnvironmentId } from "@t3tools/contracts";

/** Pushes Assistant info or Group info; works from screens and from the tablet sidebar. */
export function useOpenAssistantInfo() {
  const navigation = useNavigation();
  return {
    assistant: (environmentId: EnvironmentId, assistantId: AssistantId) =>
      navigation.navigate("AssistantInfo", { environmentId, assistantId }),
    group: (environmentId: EnvironmentId, teamId: AssistantTeamId) =>
      navigation.navigate("AssistantGroupInfo", { environmentId, teamId }),
  };
}
