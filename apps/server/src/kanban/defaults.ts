import type { KanbanAutomations } from "@t3tools/contracts";

export const DEFAULT_KANBAN_AUTOMATIONS: KanbanAutomations = {
  threadStarted: true,
  runCompleted: true,
  prMerged: true,
  definitionOfDone: true,
};
