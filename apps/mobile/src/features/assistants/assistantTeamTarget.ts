import { useNavigation } from "@react-navigation/native";
import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

export interface AssistantTeamTarget {
  readonly environmentId: EnvironmentId;
  /** Absent when creating a team. */
  readonly teamId: AssistantTeamId | null;
}

/** Which team the edit screen shows; routes carry no params, like the assistant form. */
export const assistantTeamTargetAtom = Atom.make<AssistantTeamTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-assistant-team-target"),
);

/** Opens the team form or chat from Settings and Home. */
export function useOpenAssistantTeam() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  return {
    edit: (environmentId: EnvironmentId, teamId: AssistantTeamId | null) => {
      appAtomRegistry.set(assistantTeamTargetAtom, { environmentId, teamId });
      navigation.navigate("SettingsAssistantTeamEdit");
    },
    /** Instructions, memories and the conversation actions of a group. */
    settings: (environmentId: EnvironmentId, teamId: AssistantTeamId) => {
      appAtomRegistry.set(assistantTeamTargetAtom, { environmentId, teamId });
      navigation.navigate("SettingsAssistantGroupSettings");
    },
    /** The group's chat; shown in the detail column like a thread row. */
    chat: (environmentId: EnvironmentId, teamId: AssistantTeamId) =>
      selectDetail({ name: "AssistantGroupChat", params: { environmentId, teamId } }),
  };
}
