import type { KanbanCard, KanbanColumn } from "@t3tools/contracts";

type SubtaskCard = Pick<
  KanbanCard,
  "id" | "number" | "parentCardId" | "columnId" | "archivedAt"
> & {
  readonly linkedThreadIds: ReadonlyArray<unknown>;
};
type Columns = ReadonlyArray<Pick<KanbanColumn, "id" | "role">>;

export const subtasksOf = <T extends SubtaskCard>(cards: Iterable<T>, parentId: string): T[] =>
  [...cards]
    .filter((card) => card.parentCardId === parentId && card.archivedAt === null)
    .sort((left, right) => left.number - right.number);

const isDone = (card: SubtaskCard, columns: Columns) =>
  columns.find((column) => column.id === card.columnId)?.role === "done";

export function subtaskProgress(subtasks: ReadonlyArray<SubtaskCard>, columns: Columns) {
  return { done: subtasks.filter((card) => isDone(card, columns)).length, total: subtasks.length };
}

/** What "start agents for subtasks" launches: not done and no thread yet. */
export const startableSubtasks = <T extends SubtaskCard>(
  subtasks: ReadonlyArray<T>,
  columns: Columns,
): T[] => subtasks.filter((card) => card.linkedThreadIds.length === 0 && !isDone(card, columns));
