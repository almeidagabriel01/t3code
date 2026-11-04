import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import type { HomeProjectScope } from "../home/homeThreadList";
import { filterProjectScopes, orderScopesByLastProject } from "./new-task-project-selection";

/** The new-task project list: last used first when the preference is on, then narrowed by search. */
export function useVisibleNewTaskScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const ordered = orderScopesByLastProject(
    scopes,
    AsyncResult.isSuccess(preferences) ? preferences.value : undefined,
  );
  return {
    visibleScopes: filterProjectScopes(ordered.scopes, searchText),
    lastUsedKey: ordered.lastUsedKey,
  };
}
