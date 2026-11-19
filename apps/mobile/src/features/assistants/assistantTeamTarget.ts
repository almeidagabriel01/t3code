import { useNavigation } from "@react-navigation/native";
import type { AssistantEnvironmentValue } from "@t3tools/client-runtime/assistantEnvironment";
import type { AssistantTeamId, EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

export interface AssistantTeamTarget {
  readonly environmentId: EnvironmentId;
  /** Absent when creating a team. */
  readonly teamId: AssistantTeamId | null;
  /** Group settings opens scrolled to this section. */
  readonly section?: "routines";
  /** Group settings' unsaved default model, picked on its own route; null clears it. */
  readonly defaultModelDraft?: ModelSelection | null;
  /** Its unsaved "runs on" choice; null inherits each member's own. */
  readonly defaultEnvironmentDraft?: AssistantEnvironmentValue;
}

/** Which team the edit screen shows; routes carry no params, like the assistant form. */
export const assistantTeamTargetAtom = Atom.make<AssistantTeamTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-assistant-team-target"),
);

type GroupSettingsDraft = Pick<
  AssistantTeamTarget,
  "defaultModelDraft" | "defaultEnvironmentDraft"
>;

function setGroupSettingsDraft(draft: GroupSettingsDraft) {
  const target = appAtomRegistry.get(assistantTeamTargetAtom);
  if (target === null) return;
  // Dropping the section keeps the row's layout shift from scrolling the form back to Routines.
  appAtomRegistry.set(assistantTeamTargetAtom, {
    environmentId: target.environmentId,
    teamId: target.teamId,
    ...(target.defaultModelDraft === undefined
      ? {}
      : { defaultModelDraft: target.defaultModelDraft }),
    ...(target.defaultEnvironmentDraft === undefined
      ? {}
      : { defaultEnvironmentDraft: target.defaultEnvironmentDraft }),
    ...draft,
  });
}

export const setGroupDefaultModelDraft = (defaultModelDraft: ModelSelection | null) =>
  setGroupSettingsDraft({ defaultModelDraft });

export const setGroupDefaultEnvironmentDraft = (
  defaultEnvironmentDraft: AssistantEnvironmentValue,
) => setGroupSettingsDraft({ defaultEnvironmentDraft });

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
    settings: (
      environmentId: EnvironmentId,
      teamId: AssistantTeamId,
      section?: AssistantTeamTarget["section"],
    ) => {
      appAtomRegistry.set(assistantTeamTargetAtom, { environmentId, teamId, section });
      navigation.navigate("SettingsAssistantGroupSettings");
    },
    /** The group's chat; shown in the detail column like a thread row. */
    chat: (environmentId: EnvironmentId, teamId: AssistantTeamId) =>
      selectDetail({ name: "AssistantGroupChat", params: { environmentId, teamId } }),
  };
}
