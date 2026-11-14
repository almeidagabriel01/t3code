import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** The group chat tab this device last showed for one group; resolve it against the tabs in render. */
export function useGroupTabPreference(environmentId: EnvironmentId, teamId: AssistantTeamId) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const group = `${environmentId}:${teamId}`;
  return {
    saved: AsyncResult.isSuccess(preferences)
      ? preferences.value.assistantGroupTabs?.[group]
      : undefined,
    save: (tab: string) =>
      savePreferences({
        transform: (current) => ({
          assistantGroupTabs: { ...current.assistantGroupTabs, [group]: tab },
        }),
      }),
  } as const;
}
