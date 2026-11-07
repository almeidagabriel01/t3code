import { useNavigation } from "@react-navigation/native";
import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

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
  return {
    edit: (environmentId: EnvironmentId, teamId: AssistantTeamId | null) => {
      appAtomRegistry.set(assistantTeamTargetAtom, { environmentId, teamId });
      navigation.navigate("SettingsAssistantTeamEdit");
    },
    /** The group's chat; works from the tablet sidebar too, which has no route of its own. */
    chat: (environmentId: EnvironmentId, teamId: AssistantTeamId) =>
      navigation.navigate("AssistantGroupChat", { environmentId, teamId }),
  };
}
