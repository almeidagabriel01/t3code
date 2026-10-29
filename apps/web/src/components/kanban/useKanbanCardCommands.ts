import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import { definitionOfDoneWarning } from "@t3tools/client-runtime/state/kanbanLogic";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanCardUpdateInput,
  KanbanColumnId,
  KanbanLabelId,
} from "@t3tools/contracts";

import { requestConfirmDialog } from "../../confirmDialog";
import { toastManager } from "../ui/toast";
import { useKanbanActions } from "./useKanban";

/** The card actions the detail sheet and the tile quick editor share. */
export function useKanbanCardCommands(
  environmentId: EnvironmentId,
  board: KanbanBoardState,
  card: KanbanCard,
) {
  const actions = useKanbanActions(environmentId);
  const patch = (input: Omit<KanbanCardUpdateInput, "commandId" | "actor" | "cardId">) =>
    actions.updateCard({ cardId: card.id, ...input });

  const moveTo = async (columnId: KanbanColumnId) => {
    const target = board.columns.find((entry) => entry.id === columnId);
    const moved = await actions.moveCard({ cardId: card.id, columnId });
    const warning = target === undefined ? null : definitionOfDoneWarning(board, card, target);
    if (moved !== null && warning !== null) {
      toastManager.add({
        type: "warning",
        title: "Moved without meeting the definition of done",
        description: warning,
      });
    }
  };

  /** Resolves true once the card is gone. */
  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      `Delete #${card.number}?\nThe card, its comments, attachments and activity are removed for good.`,
      { variant: "destructive" },
    );
    if (confirmed === false) return false;
    return (await actions.deleteCard({ cardId: card.id })) !== null;
  };

  const archive = async () => (await actions.archiveCard({ cardId: card.id })) !== null;

  const toggleLabel = (labelId: KanbanLabelId) =>
    void patch({
      labelIds: card.labelIds.includes(labelId)
        ? card.labelIds.filter((id) => id !== labelId)
        : [...card.labelIds, labelId],
    });

  return { actions, patch, moveTo, remove, archive, toggleLabel };
}
