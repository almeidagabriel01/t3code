import type { KanbanChecklistItem, KanbanColumnRole } from "@t3tools/contracts";

export type DefinitionOfDoneVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: ReadonlyArray<string> };

/** Agent and automation moves into a review or done column need a finished checklist and a summary. */
export const checkDefinitionOfDone = (input: {
  readonly enabled: boolean;
  readonly targetRole: KanbanColumnRole;
  readonly checklist: ReadonlyArray<Pick<KanbanChecklistItem, "text" | "done">>;
  readonly summary: string | undefined;
  /** Live subtasks outside the done column, as "#12 Title". */
  readonly openSubtasks?: ReadonlyArray<string>;
}): DefinitionOfDoneVerdict => {
  if (!input.enabled || (input.targetRole !== "review" && input.targetRole !== "done")) {
    return { ok: true };
  }
  const missing = input.checklist
    .filter((item) => !item.done)
    .map((item) => `checklist item not done: ${item.text}`);
  for (const subtask of input.openSubtasks ?? []) missing.push(`subtask not done: ${subtask}`);
  if (input.summary === undefined || input.summary.trim() === "") {
    missing.push("a completion summary (the `summary` field)");
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
};
