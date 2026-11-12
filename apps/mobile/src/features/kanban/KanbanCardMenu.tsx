import type { MenuAction } from "@react-native-menu/menu";
import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import {
  definitionOfDoneWarning,
  dueAtToInput,
  inputToDueAt,
} from "@t3tools/client-runtime/state/kanbanLogic";
import type { EnvironmentId, KanbanCard, KanbanColumnId, KanbanLabelId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useKanbanActions } from "./useKanbanActions";

const MOVE = "move:";
const LABEL = "label:";

/** Open, rename and the rest of Trello's quick editor; the other columns and the board's labels are submenus. */
export function kanbanCardMenuActions(
  board: Pick<KanbanBoardState, "columns" | "labels">,
  card: Pick<KanbanCard, "columnId" | "labelIds">,
): MenuAction[] {
  const columns = board.columns.filter((column) => column.id !== card.columnId);
  return [
    { id: "open", title: "Open", image: "arrow.up.right.square" },
    { id: "rename", title: "Rename…", image: "pencil" },
    ...(columns.length === 0
      ? []
      : [
          {
            id: "move",
            title: "Move to",
            image: "arrow.right",
            subactions: columns.map((column) => ({ id: MOVE + column.id, title: column.name })),
          },
        ]),
    ...(board.labels.length === 0
      ? []
      : [
          {
            id: "labels",
            title: "Labels",
            image: "tag",
            subactions: board.labels.map((label) => ({
              id: LABEL + label.id,
              title: label.name,
              state: card.labelIds.includes(label.id) ? ("on" as const) : ("off" as const),
            })),
          },
        ]),
    { id: "due", title: "Due date…", image: "calendar" },
    { id: "archive", title: "Archive", image: "archivebox" },
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
}

export function promptDueDate(dueAt: string | null, save: (dueAt: string | null) => void) {
  Dialog.prompt({
    title: "Due date",
    message: "YYYY-MM-DD, or empty to clear.",
    initialValue: dueAtToInput(dueAt),
    confirmText: "Save",
    onConfirm: (value) => {
      const text = value.trim();
      const next = text === "" ? null : inputToDueAt(text);
      if (text !== "" && next === null) {
        Dialog.alert("Invalid date", "Use the format YYYY-MM-DD.");
        return;
      }
      save(next);
    },
  });
}

/** Long-press quick actions on a card tile; read-only connections get the bare tile. */
export function KanbanCardMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
  readonly onOpen: () => void;
  /** Opens on a plain press, for a visible ⋯ button; the tile itself opens on long press. */
  readonly openOnPress?: boolean;
  readonly children: ReactNode;
}) {
  const { board, card } = props;
  const actions = useKanbanActions(props.environmentId);
  if (!actions.canEdit) return props.children;
  const cardId = card.id;

  const run = async (id: string) => {
    if (id.startsWith(MOVE)) {
      const columnId = id.slice(MOVE.length) as KanbanColumnId;
      const target = board.columns.find((column) => column.id === columnId);
      const moved = await actions.moveCard({ cardId, columnId });
      const warning =
        moved && target !== undefined ? definitionOfDoneWarning(board, card, target) : null;
      if (warning !== null) Dialog.alert("Moved without meeting the definition of done", warning);
    } else if (id.startsWith(LABEL)) {
      const labelId = id.slice(LABEL.length) as KanbanLabelId;
      void actions.updateCard({
        cardId,
        labelIds: card.labelIds.includes(labelId)
          ? card.labelIds.filter((entry) => entry !== labelId)
          : [...card.labelIds, labelId],
      });
    } else if (id === "open") {
      props.onOpen();
    } else if (id === "rename") {
      Dialog.prompt({
        title: "Rename card",
        placeholder: "Title",
        initialValue: card.title,
        confirmText: "Save",
        onConfirm: (value) => {
          const title = value.trim();
          if (title.length > 0 && title !== card.title) void actions.updateCard({ cardId, title });
        },
      });
    } else if (id === "due") {
      promptDueDate(card.dueAt, (dueAt) => void actions.updateCard({ cardId, dueAt }));
    } else if (id === "archive") {
      void actions.archiveCard({ cardId });
    } else if (id === "delete") {
      Dialog.confirm({
        title: `Delete #${card.number}?`,
        message: "The card, its comments and its activity are removed for good.",
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => void actions.deleteCard({ cardId }),
      });
    }
  };

  return (
    <Menu
      actions={kanbanCardMenuActions(board, card)}
      onPressAction={({ nativeEvent }) => void run(nativeEvent.event)}
      shouldOpenOnLongPress={props.openOnPress !== true}
    >
      {props.children}
    </Menu>
  );
}
