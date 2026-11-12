import type { KanbanPanelScope } from "@t3tools/client-runtime/state/kanbanLogic";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

interface KanbanPanelState {
  /** Keyed by the thread's project scope key. */
  scopeByProject: Record<string, KanbanPanelScope>;
  /** Board id, then column id: the viewer's collapse choice for that section. */
  collapsedByBoard: Record<string, Record<string, boolean>>;
  setScope: (projectKey: string, scope: KanbanPanelScope) => void;
  setCollapsed: (boardId: string, columnId: string, collapsed: boolean) => void;
}

/** The right panel's board choice and collapsed sections, kept per viewer. */
export const useKanbanPanelStore = create<KanbanPanelState>()(
  persist(
    (set) => ({
      scopeByProject: {},
      collapsedByBoard: {},
      setScope: (projectKey, scope) =>
        set((state) => ({ scopeByProject: { ...state.scopeByProject, [projectKey]: scope } })),
      setCollapsed: (boardId, columnId, collapsed) =>
        set((state) => ({
          collapsedByBoard: {
            ...state.collapsedByBoard,
            [boardId]: { ...state.collapsedByBoard[boardId], [columnId]: collapsed },
          },
        })),
    }),
    {
      name: "t3code:kanban-panel:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ scopeByProject, collapsedByBoard }) => ({ scopeByProject, collapsedByBoard }),
    },
  ),
);
