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
    /** A function decides from the tab saved when it runs; null keeps that one. */
    save: (tab: string | ((saved: string | undefined) => string | null)) =>
      savePreferences({
        transform: (current) => {
          const next = typeof tab === "string" ? tab : tab(current.assistantGroupTabs?.[group]);
          return next === null
            ? {}
            : { assistantGroupTabs: { ...current.assistantGroupTabs, [group]: next } };
        },
      }),
  } as const;
}
