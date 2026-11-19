import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { toggleFoldKey } from "@t3tools/client-runtime/assistantList";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** The groups opened this session, shared by Home and the tablet sidebar; it still works when storage fails. */
export const sessionExpandedGroupsAtom = Atom.make<ReadonlyArray<string> | null>(null).pipe(
  Atom.keepAlive,
);

const NO_GROUPS: ReadonlyArray<string> = [];

/** Which Home zones and folders are folded: Teams and each assistant open, groups closed by default. */
export function useHomeSectionPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const sessionExpandedGroups = useAtomValue(sessionExpandedGroupsAtom);
  const setSessionExpandedGroups = useAtomSet(sessionExpandedGroupsAtom);
  const assistantsExpandedGroups =
    sessionExpandedGroups ??
    (loaded ? (preferencesResult.value.homeAssistantsExpandedGroups ?? NO_GROUPS) : NO_GROUPS);
  // Stable, so memoized rows that take them do not redraw when the preferences change.
  const toggleAssistantFolded = useCallback(
    (key: string) => {
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
    [loaded, savePreferences],
  );
  const toggleAssistantsGroup = useCallback(
    (foldKey: string) => {
      const next = toggleFoldKey(assistantsExpandedGroups, foldKey);
      setSessionExpandedGroups(next);
      if (loaded) savePreferences({ homeAssistantsExpandedGroups: next });
    },
    [assistantsExpandedGroups, loaded, savePreferences, setSessionExpandedGroups],
  );
  // Transforms read optimistic state so same-frame presses toggle twice.
  return {
    assistantsCollapsed: loaded && preferencesResult.value.homeAssistantsCollapsed === true,
    assistantsShowAll: loaded && preferencesResult.value.homeAssistantsShowAll === true,
    /** Folded assistants, by `env:assistantId`; open by default, as a project's list is. */
    assistantsFolded: new Set(loaded ? (preferencesResult.value.homeAssistantsFolded ?? []) : []),
    toggleAssistantFolded,
    assistantsExpandedGroups,
    toggleAssistantsGroup,
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
  } as const;
}
