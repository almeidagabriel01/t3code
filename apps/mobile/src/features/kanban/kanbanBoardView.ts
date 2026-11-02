import { selectKanbanColumns, type KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import {
  boardScopeKey,
  collectGlobalCards,
  groupCardsByRole,
  KANBAN_ROLE_LABELS,
  type GlobalBoard,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type {
  EnvironmentId,
  KanbanBoardId,
  KanbanCard,
  KanbanColumnId,
  KanbanTemplate,
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
    readonly templates: ReadonlyArray<KanbanTemplate>;
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
      addTo: {
        environmentId,
        boardId: board.id,
        columnId: column.id,
        templates: board.templates,
      },
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

export interface NewBoardTarget {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  /** null is the No-project board: the Scratch project is ensured first. */
  readonly projectId: ProjectId | null;
}

/** Projects without a board yet, plus "No project" where the server offers it and it has none. */
export function newBoardTargets(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly scratchWorkspaceRoot: string | null;
  }>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  readonly boards: ReadonlyArray<GlobalBoard>;
}): ReadonlyArray<NewBoardTarget> {
  const hasBoard = new Set(
    input.boards.map((entry) => boardScopeKey(entry.environmentId, entry.board.projectId)),
  );
  return input.environments.flatMap(({ environmentId, scratchWorkspaceRoot }) => {
    const own = input.projects.filter((project) => project.environmentId === environmentId);
    const scratch = own.find((project) => isScratchProject(project, scratchWorkspaceRoot));
    const named = own
      .filter(
        (project) => project !== scratch && !hasBoard.has(boardScopeKey(environmentId, project.id)),
      )
      .map((project) => ({
        key: boardScopeKey(environmentId, project.id),
        environmentId,
        title: project.title,
        projectId: project.id,
      }));
    const noProject =
      scratchWorkspaceRoot === null ||
      (scratch !== undefined && hasBoard.has(boardScopeKey(environmentId, scratch.id)))
        ? []
        : [
            {
              key: `${environmentId}:no-project`,
              environmentId,
              title: "No project",
              projectId: null,
            },
          ];
    return [...noProject, ...named];
  });
}
