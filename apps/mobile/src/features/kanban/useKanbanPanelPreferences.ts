import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { KanbanPanelScope } from "@t3tools/client-runtime/state/kanbanLogic";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** A project board's chosen scope and folded sections, saved with the other mobile preferences. */
export function useKanbanPanelPreferences() {
  const result = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const panel = AsyncResult.isSuccess(result) ? result.value.kanbanPanel : undefined;
  // Transforms read optimistic state so quick presses each apply.
  return {
    scopes: panel?.scopes ?? {},
    collapsed: panel?.collapsed ?? {},
    setScope: (scopeKey: string, scope: KanbanPanelScope) =>
      save({
        transform: (current) => ({
          kanbanPanel: {
            ...current.kanbanPanel,
            scopes: { ...current.kanbanPanel?.scopes, [scopeKey]: scope },
          },
        }),
      }),
    setCollapsed: (boardId: string, columnId: string, collapsed: boolean) =>
      save({
        transform: (current) => ({
          kanbanPanel: {
            ...current.kanbanPanel,
            collapsed: {
              ...current.kanbanPanel?.collapsed,
              [boardId]: { ...current.kanbanPanel?.collapsed?.[boardId], [columnId]: collapsed },
            },
          },
        }),
      }),
  } as const;
}
