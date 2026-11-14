import { useAtom } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  type AssistantGroupTabKey,
  type AssistantGroupTabPick,
  assistantGroupTabPick,
} from "@t3tools/client-runtime/assistantGroupChat";
import type { AssistantTeamId, EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { SettingsModelPicker } from "../settings/components/SettingsModelPicker";

/** A group composer's model for the next message, per group; it is picked on its own route. */
export const groupMessageModelAtom = Atom.family((_teamId: AssistantTeamId) =>
  Atom.make<AssistantGroupTabPick<ModelSelection> | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile-group-message-model"),
  ),
);

type GroupMessageModelParams = {
  readonly environmentId: EnvironmentId;
  /** The project the message runs in, whose models are offered. */
  readonly projectId: ProjectId;
  readonly teamId: AssistantTeamId;
  readonly tab: AssistantGroupTabKey | null;
  /** What the chip shows, the picker's starting point. */
  readonly selected: ModelSelection | null;
};

/** Picks the model of the group's next message only; nothing saves. */
export function GroupMessageModelPickerRouteScreen({
  route,
}: StaticScreenProps<GroupMessageModelParams>) {
  const { environmentId, projectId, teamId, tab, selected } = route.params;
  const navigation = useNavigation();
  const [pick, setPick] = useAtom(groupMessageModelAtom(teamId));
  return (
    <SettingsModelPicker
      title="Model for this message"
      environmentId={environmentId}
      projectId={projectId}
      selected={assistantGroupTabPick(pick, tab)?.value ?? selected}
      onPick={(selection) => setPick({ tab, value: selection })}
      onClose={() => navigation.goBack()}
    />
  );
}
