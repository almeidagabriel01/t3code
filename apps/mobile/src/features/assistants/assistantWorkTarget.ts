import { useNavigation } from "@react-navigation/native";
import type { AssistantId, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

export interface AssistantWorkTarget {
  readonly environmentId: EnvironmentId;
  readonly assistantId: AssistantId;
}

/** Which assistant's Work screen is open; routes carry no params, like the assistant form. */
export const assistantWorkTargetAtom = Atom.make<AssistantWorkTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-assistant-work-target"),
);

/** Opens the Work screen from Home, the tablet sidebar and the thread menu. */
export function useOpenAssistantWork() {
  const navigation = useNavigation();
  return (environmentId: EnvironmentId, assistantId: AssistantId) => {
    appAtomRegistry.set(assistantWorkTargetAtom, { environmentId, assistantId });
    navigation.navigate("SettingsAssistantWork");
  };
}
