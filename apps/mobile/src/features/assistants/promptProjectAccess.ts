import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Keyboard } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { useAssistantEntries } from "../../state/assistants";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import { openSettings } from "../settings/settings-navigation";

/** After a project is added: offers to give assistants access when the environment has any. */
export function usePromptProjectAssistantAccess() {
  const navigation = useNavigation();
  const entries = useAssistantEntries();
  const { readProjectGroups, selectAllProjects, toggleProject } = useSettingsEnvironmentFilter();
  return (environmentId: EnvironmentId, projectId: ProjectId, title: string) => {
    const relevant =
      entries.activeTeams.some((entry) => entry.environmentId === environmentId) ||
      entries.active.some(
        (entry) => entry.environmentId === environmentId && entry.assistant.scope === "project",
      );
    // Read now: the project was added after the render that made this callback.
    const group = readProjectGroups().find((candidate) =>
      candidate.members.some(
        (member) =>
          member.project.environmentId === environmentId && member.project.id === projectId,
      ),
    );
    if (!relevant || group === undefined) return;
    Keyboard.dismiss();
    Dialog.alert(
      `Let assistants work in ${title}?`,
      "Choose which groups and assistants can use it.",
      [
        { text: "Not now", style: "cancel" },
        {
          text: "Choose assistants",
          onPress: () => {
            selectAllProjects();
            toggleProject(group.key);
            openSettings(navigation, "SettingsProjectOverview");
          },
        },
      ],
    );
  };
}
