import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import { definitionOfDoneWarning, type CardMove } from "@t3tools/client-runtime/state/kanbanLogic";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { toastManager } from "../ui/toast";
import { useKanbanActions, useKanbanCanEdit } from "./useKanban";

/** Moves a card and warns when the move skips the board's definition of done. */
export function useMoveKanbanCard(environmentId: EnvironmentId, board: KanbanBoardState) {
  const actions = useKanbanActions(environmentId);
  return async (move: CardMove) => {
    const card = board.cards.get(move.cardId);
    const target = board.columns.find((column) => column.id === move.columnId);
    const { cardId, ...position } = move;
    const moved = await actions.moveCard({ cardId, ...position });
    const warning =
      card === undefined || target === undefined
        ? null
        : definitionOfDoneWarning(board, card, target);
    if (moved !== null && warning !== null) {
      toastManager.add({
        type: "warning",
        title: "Moved without meeting the definition of done",
        description: warning,
      });
    }
    return moved;
  };
}

/** The server creates a project's board the first time someone who can edit opens it. */
export function useEnsureKanbanBoard(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  missing: boolean,
) {
  const canEdit = useKanbanCanEdit(environmentId);
  const actions = useKanbanActions(environmentId);
  const ensuring = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server creates a project's board the first time it is opened
  useEffect(() => {
    if (!missing || !canEdit || projectId === null || ensuring.current) return;
    ensuring.current = true;
    void actions.ensureBoard({ projectId }).finally(() => {
      ensuring.current = false;
    });
  }, [missing, canEdit, actions, projectId]);
}
