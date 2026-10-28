import { selectKanbanColumns, type KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import {
  boardScopeKey,
  collectGlobalCards,
  groupCardsByRole,
  KANBAN_ROLE_LABELS,
  type GlobalBoard,
} from "@t3tools/client-runtime/state/kanbanLogic";
import type {
  EnvironmentId,
  KanbanBoardId,
  KanbanCard,
  KanbanColumnId,
  ProjectId,
} from "@t3tools/contracts";

export const ALL_PROJECTS = "all";

export interface BoardViewCard {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
  /** Set only on the merged board, where cards of several projects share a column. */
  readonly projectId: ProjectId | null;
}

export interface BoardViewColumn {
  readonly key: string;
  readonly title: string;
  readonly color: string | null;
  readonly wipLimit: number | null;
  readonly cards: ReadonlyArray<BoardViewCard>;
  /** Where a quick-added card goes; the merged board has no single target. */
  readonly addTo: {
    readonly environmentId: EnvironmentId;
    readonly boardId: KanbanBoardId;
    readonly columnId: KanbanColumnId;
  } | null;
}

/** One board's own columns, or every board merged into one column per column role. */
export function buildBoardColumns(
  boards: ReadonlyArray<GlobalBoard>,
  scope: string,
): ReadonlyArray<BoardViewColumn> {
  if (scope !== ALL_PROJECTS) {
    const entry = boards.find(
      (item) => boardScopeKey(item.environmentId, item.board.projectId) === scope,
    );
    if (entry === undefined) return [];
    const { environmentId, board } = entry;
    return selectKanbanColumns(board).map(({ column, cards }) => ({
      key: column.id,
      title: column.name,
      color: column.color,
      wipLimit: column.wipLimit,
      cards: cards.map((card) => ({ environmentId, board, card, projectId: null })),
      addTo: { environmentId, boardId: board.id, columnId: column.id },
    }));
  }
  const boardById = new Map(boards.map((entry) => [entry.board.id, entry]));
  return groupCardsByRole(collectGlobalCards(boards)).map(({ role, cards }) => ({
    key: role,
    title: KANBAN_ROLE_LABELS[role],
    color: null,
    wipLimit: null,
    cards: cards.flatMap((entry) => {
      const owner = boardById.get(entry.boardId);
      return owner === undefined
        ? []
        : [
            {
              environmentId: entry.environmentId,
              board: owner.board,
              card: entry.card,
              projectId: entry.projectId,
            },
          ];
    }),
    addTo: null,
  }));
}
