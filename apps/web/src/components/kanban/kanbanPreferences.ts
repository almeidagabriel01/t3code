import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

const KanbanGlobalLayout = Schema.Literals(["merged", "lanes"]);

export function useKanbanGlobalLayout() {
  return useLocalStorage("t3code:kanban:global-layout", "merged", KanbanGlobalLayout);
}
