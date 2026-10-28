import { selectKanbanColumns, type KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanCardId,
  KanbanColumn,
  KanbanColumnId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { toastManager } from "../ui/toast";
import { definitionOfDoneWarning, type CardMove } from "@t3tools/client-runtime/state/kanbanLogic";
import { KanbanColumnHeader } from "./KanbanColumnHeader";
import { KanbanColumns } from "./KanbanColumns";
import type { KanbanProjectInfo } from "./KanbanProjectBadge";
import { KanbanLinkThreadDialog } from "./KanbanLinkDialogs";
import { KanbanStartAgentDialog } from "./KanbanStartAgent";
import { useKanbanActions } from "./useKanban";

function isEditable(target: EventTarget) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export function KanbanBoardView(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly canEdit: boolean;
  readonly focusNewCard?: boolean;
  readonly project?: KanbanProjectInfo | undefined;
  /** Hides every other card, as the global board's filters do. */
  readonly visibleCardIds?: ReadonlySet<KanbanCardId> | undefined;
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  const { board, environmentId } = props;
  const actions = useKanbanActions(environmentId);
  const root = useRef<HTMLDivElement>(null);
  const [startFor, setStartFor] = useState<KanbanCard | null>(null);
  const [linkFor, setLinkFor] = useState<KanbanCard | null>(null);
  const { visibleCardIds } = props;
  const columns = (() => {
    const all = selectKanbanColumns(board);
    return visibleCardIds === undefined
      ? all
      : all.map((entry) => ({
          column: entry.column,
          cards: entry.cards.filter((card) => visibleCardIds.has(card.id)),
        }));
  })();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the DOM quick-add field once when opened via the New card command
  useEffect(() => {
    if (props.focusNewCard) root.current?.querySelector<HTMLElement>("[data-quick-add]")?.click();
  }, [props.focusNewCard]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key.toLowerCase() !== "n" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isEditable(event.target)) return;
    event.preventDefault();
    root.current?.querySelector<HTMLElement>("[data-quick-add]")?.click();
  };

  const moveCard = async (move: CardMove, _from: KanbanColumn, to: KanbanColumn) => {
    const card = board.cards.get(move.cardId);
    const { cardId, ...position } = move;
    const result = await actions.moveCard({ cardId, ...position });
    const warning = card === undefined ? null : definitionOfDoneWarning(board, card, to);
    if (result !== null && warning !== null) {
      toastManager.add({
        type: "warning",
        title: "Moved without meeting the definition of done",
        description: warning,
      });
    }
  };

  return (
    // The board is a keyboard scope for the N shortcut, not an interactive control.
    <div ref={root} className="h-full min-h-0" onKeyDown={onKeyDown}>
      <KanbanColumns
        environmentId={environmentId}
        columns={columns}
        labels={board.labels}
        templates={board.templates}
        canEdit={props.canEdit}
        tileFor={props.project ? () => ({ project: props.project }) : undefined}
        onOpenCard={props.onOpenCard}
        onStartAgent={setStartFor}
        onLinkThread={setLinkFor}
        renderHeader={(column, count) => (
          <KanbanColumnHeader
            environmentId={environmentId}
            column={column}
            siblings={board.columns}
            count={count}
            canEdit={props.canEdit}
          />
        )}
        onMoveCard={moveCard}
        onMoveColumn={(columnId, position) => actions.moveColumn({ columnId, ...position })}
        onAddCard={(columnId: KanbanColumnId, title, type) =>
          void actions.createCard({
            boardId: board.id,
            columnId,
            title,
            ...(type === null ? {} : { type }),
          })
        }
      />
      {startFor ? (
        <KanbanStartAgentDialog
          environmentId={environmentId}
          board={board}
          card={startFor}
          onClose={() => setStartFor(null)}
        />
      ) : null}
      {linkFor ? (
        <KanbanLinkThreadDialog
          environmentId={environmentId}
          board={board}
          card={linkFor}
          onClose={() => setLinkFor(null)}
        />
      ) : null}
    </div>
  );
}
