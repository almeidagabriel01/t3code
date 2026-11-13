import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Which Home sections are folded: assistants open and agents' Done group closed by default. */
export function useHomeSectionPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  // Transforms read optimistic state so same-frame presses toggle twice.
  return {
    assistantsCollapsed: loaded && preferencesResult.value.homeAssistantsCollapsed === true,
    assistantsShowAll: loaded && preferencesResult.value.homeAssistantsShowAll === true,
    agentsDoneExpanded: loaded && preferencesResult.value.homeAgentsDoneExpanded === true,
    /** Folded assistants, by `env:assistantId`; open by default, as a project's list is. */
    assistantsFolded: new Set(loaded ? (preferencesResult.value.homeAssistantsFolded ?? []) : []),
    toggleAssistantFolded: (key: string) => {
      if (!loaded) return;
      savePreferences({
        transform: (current) => {
          const folded = current.homeAssistantsFolded ?? [];
          return {
            homeAssistantsFolded: folded.includes(key)
              ? folded.filter((candidate) => candidate !== key)
              : [...folded, key],
          };
        },
      });
    },
    toggleAssistants: () => {
      if (!loaded) return;
      savePreferences({
        transform: (current) => ({
          homeAssistantsCollapsed: current.homeAssistantsCollapsed !== true,
        }),
      });
    },
    toggleAssistantsShowAll: () => {
      if (!loaded) return;
      savePreferences({
        transform: (current) => ({
          homeAssistantsShowAll: current.homeAssistantsShowAll !== true,
        }),
      });
    },
    toggleAgentsDone: () => {
      if (!loaded) return;
      savePreferences({
        transform: (current) => ({
          homeAgentsDoneExpanded: current.homeAgentsDoneExpanded !== true,
        }),
      });
    },
  } as const;
}
