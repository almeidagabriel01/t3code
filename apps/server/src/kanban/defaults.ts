import type { KanbanAutomations, KanbanColumnRole, KanbanPriority } from "@t3tools/contracts";

export const DEFAULT_KANBAN_AUTOMATIONS: KanbanAutomations = {
  threadStarted: true,
  runCompleted: true,
  prMerged: true,
  definitionOfDone: true,
};

export const DEFAULT_KANBAN_COLUMNS: ReadonlyArray<{
  readonly name: string;
  readonly color: string;
  readonly role: KanbanColumnRole;
}> = [
  { name: "Backlog", color: "slate", role: "backlog" },
  { name: "To do", color: "blue", role: "todo" },
  { name: "In progress", color: "amber", role: "in-progress" },
  { name: "Review", color: "violet", role: "review" },
  { name: "Done", color: "green", role: "done" },
];

export const DEFAULT_KANBAN_TEMPLATES: ReadonlyArray<{
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly priority: KanbanPriority;
  readonly checklist: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
}> = [
  {
    name: "Bug",
    icon: "bug",
    color: "red",
    priority: "high",
    checklist: ["Reproduce the bug", "Find the root cause", "Fix it", "Add a regression test"],
    acceptanceCriteria: ["The bug no longer reproduces", "A test covers the failing case"],
  },
  {
    name: "Feature",
    icon: "sparkles",
    color: "blue",
    priority: "medium",
    checklist: ["Clarify the behavior", "Implement", "Add tests", "Update docs if needed"],
    acceptanceCriteria: ["The feature works as described", "Tests cover the new behavior"],
  },
  {
    name: "Refactor",
    icon: "wrench",
    color: "violet",
    priority: "low",
    checklist: ["Confirm current behavior with tests", "Refactor", "Run the full checks"],
    acceptanceCriteria: ["Behavior is unchanged", "Checks pass"],
  },
  {
    name: "Chore",
    icon: "broom",
    color: "slate",
    priority: "low",
    checklist: ["Do the work", "Verify nothing else broke"],
    acceptanceCriteria: ["The chore is complete"],
  },
];
