import { useNavigation } from "@react-navigation/native";
import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";

import { useScheduledTaskEditor } from "../settings/scheduled-task-editor";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";

/** Opens the new scheduled task form already set to post in a group's chat. */
export function useScheduleInGroup() {
  const navigation = useNavigation();
  const { draftForEnvironment, startEditor } = useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  return (environmentId: EnvironmentId, teamId: AssistantTeamId) => {
    startEditor({
      environmentId,
      environmentLabel:
        availableTargets.find((target) => target.environmentId === environmentId)?.label ?? "",
      draft: { ...draftForEnvironment(environmentId), assistantTeamId: teamId },
    });
    navigation.navigate("SettingsScheduledTaskNew");
  };
}
