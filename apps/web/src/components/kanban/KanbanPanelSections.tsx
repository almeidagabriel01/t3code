import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { selectKanbanColumns, type KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import {
  checklistProgress,
  dropToMove,
  kanbanSectionCollapsed,
  withOptimisticMove,
  type CardMove,
  type OptimisticMove,
} from "@t3tools/client-runtime/state/kanbanLogic";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanCardId,
  KanbanColumn,
  KanbanColumnId,
  KanbanLabel,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArchiveIcon,
  ArrowRightLeftIcon,
  EllipsisIcon,
  ListChecksIcon,
  PanelRightOpenIcon,
  PlusIcon,
  SquareKanbanIcon,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { kanbanPanelThreadState, type KanbanPanelThreadState } from "./kanbanPanel.logic";
import { useKanbanPanelStore } from "./kanbanPanelStore";
import { useKanbanActions } from "./useKanban";
import { useMoveKanbanCard } from "./useKanbanBoardCommands";
import { ColorDot, LabelChip, PriorityIcon } from "./kanbanPresentation";

const MAX_ROW_LABELS = 2;
const MAX_ROW_THREADS = 3;

// Sections are drop targets as a whole, so a collapsed section still takes a dropped card.
const collisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCenter(args);
};

export interface KanbanPanelSectionsProps {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly canEdit: boolean;
  readonly onOpenCard: (card: KanbanCard) => void;
  readonly onOpenOnBoard: (card: KanbanCard) => void;
  readonly onAddCard: (columnId: KanbanColumnId) => void;
  /** Rendered at the top of the section that is adding a card. */
  readonly quickAdd: { readonly columnId: KanbanColumnId; readonly node: ReactNode } | null;
}

/** The board as stacked, collapsible sections: one per column, for a narrow panel. */
export function KanbanPanelSections(props: KanbanPanelSectionsProps) {
  const { board, environmentId } = props;
  const collapsedForBoard = useKanbanPanelStore((state) => state.collapsedByBoard[board.id]);
  const setCollapsed = useKanbanPanelStore((state) => state.setCollapsed);
  const moveCard = useMoveKanbanCard(environmentId, board);
  const [optimistic, setOptimistic] = useState<OptimisticMove | null>(null);
  const [dragging, setDragging] = useState<KanbanCard | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sections = withOptimisticMove(selectKanbanColumns(board), optimistic);

  const move = (card: KanbanCard, target: Omit<CardMove, "cardId">) => {
    setOptimistic({
      move: { ...target, cardId: card.id },
      columnId: card.columnId,
      orderKey: card.orderKey,
    });
    void moveCard({ ...target, cardId: card.id }).finally(() => setOptimistic(null));
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    if (event.over === null) return;
    const next = dropToMove(
      String(event.active.id) as KanbanCardId,
      String(event.over.id),
      sections.map((entry) => ({
        columnId: entry.column.id,
        cardIds: entry.cards.map((card) => card.id),
      })),
    );
    const card = next === null ? undefined : board.cards.get(next.cardId);
    if (next === null || card === undefined) return;
    move(card, next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={(event) =>
        setDragging(board.cards.get(String(event.active.id) as KanbanCardId) ?? null)
      }
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex flex-col gap-1">
        {sections.map(({ column, cards }) => {
          const adding = props.quickAdd?.columnId === column.id;
          const collapsed = !adding && kanbanSectionCollapsed(column, collapsedForBoard);
          return (
            <KanbanPanelSection
              key={column.id}
              column={column}
              count={cards.length}
              collapsed={collapsed}
              canEdit={props.canEdit}
              onToggle={() => setCollapsed(board.id, column.id, !collapsed)}
              onAdd={() => props.onAddCard(column.id)}
            >
              {adding ? props.quickAdd?.node : null}
              <SortableContext
                items={cards.map((card) => card.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="flex flex-col">
                  {cards.map((card) => (
                    <KanbanPanelRow
                      key={card.id}
                      card={card}
                      environmentId={environmentId}
                      labels={board.labels}
                      columns={board.columns}
                      canEdit={props.canEdit}
                      onOpen={props.onOpenCard}
                      onOpenOnBoard={props.onOpenOnBoard}
                      onMove={(columnId) => move(card, { columnId })}
                    />
                  ))}
                </ul>
              </SortableContext>
              {cards.length === 0 && !adding ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No cards</p>
              ) : null}
            </KanbanPanelSection>
          );
        })}
      </div>
      <DragOverlay>
        {dragging ? (
          <div className="dropdown-glass rounded-lg border border-foreground/12 px-3 py-2 text-sm font-medium shadow-lg">
            {dragging.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function KanbanPanelSection(props: {
  readonly column: KanbanColumn;
  readonly count: number;
  readonly collapsed: boolean;
  readonly canEdit: boolean;
  readonly onToggle: () => void;
  readonly onAdd: () => void;
  readonly children: ReactNode;
}) {
  const { column } = props;
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <section
      ref={setNodeRef}
      aria-label={column.name}
      data-kanban-section={column.id}
      className={cn("rounded-lg transition-colors", isOver && "bg-foreground/6")}
    >
      <div className="flex items-center gap-0.5">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={!props.collapsed}
            onClick={props.onToggle}
            accessory={
              <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                {props.count}
              </span>
            }
          >
            <ColorDot color={column.color} /> {column.name}
          </CollapsibleSectionHeader>
        </div>
        {props.canEdit ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Add a card to ${column.name}`}
                  onClick={props.onAdd}
                />
              }
            >
              <PlusIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="left">Add a card to {column.name}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {props.collapsed ? null : props.children}
    </section>
  );
}

const THREAD_DOT_CLASS: Record<KanbanPanelThreadState, string> = {
  attention: "bg-warning",
  running: "bg-info",
  idle: "bg-foreground/30",
};

const THREAD_DOT_LABEL: Record<KanbanPanelThreadState, string> = {
  attention: "Linked agent needs you",
  running: "Linked agent working",
  idle: "Linked agent idle",
};

/** One dot per linked thread; static, since a card can stay linked for a whole run. */
function LinkedThreadDot(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const state = kanbanPanelThreadState(
    useQuietThreadShell({ environmentId: props.environmentId, threadId: props.threadId }),
    threadRuntimeIsActive,
  );
  if (state === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={THREAD_DOT_LABEL[state]}
            className={cn("size-1.5 shrink-0 rounded-full", THREAD_DOT_CLASS[state])}
          />
        }
      />
      <TooltipPopup>{THREAD_DOT_LABEL[state]}</TooltipPopup>
    </Tooltip>
  );
}

const KanbanPanelRow = memo(function KanbanPanelRow(props: {
  readonly card: KanbanCard;
  readonly environmentId: EnvironmentId;
  readonly labels: ReadonlyArray<KanbanLabel>;
  readonly columns: ReadonlyArray<KanbanColumn>;
  readonly canEdit: boolean;
  readonly onOpen: (card: KanbanCard) => void;
  readonly onOpenOnBoard: (card: KanbanCard) => void;
  readonly onMove: (columnId: KanbanColumnId) => void;
}) {
  const { card } = props;
  const actions = useKanbanActions(props.environmentId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: !props.canEdit,
  });
  const progress = checklistProgress(card.checklist);
  const labels = card.labelIds.flatMap((id) => props.labels.filter((label) => label.id === id));
  const otherColumns = props.columns.filter((column) => column.id !== card.columnId);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/row rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isDragging && "opacity-40",
      )}
      data-kanban-card={card.id}
      {...attributes}
      {...listeners}
      aria-roledescription="Draggable card"
    >
      <div className="flex items-start gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/6 has-focus-visible:bg-foreground/6">
        <button
          type="button"
          onClick={() => props.onOpen(card)}
          className="grid min-w-0 flex-1 cursor-pointer gap-0.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="line-clamp-2 text-sm leading-snug font-medium text-foreground [overflow-wrap:anywhere]">
            {card.title}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0 tabular-nums">#{card.number}</span>
            <PriorityIcon priority={card.priority} />
            {progress.total > 0 ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 tabular-nums"
                aria-label={`Checklist ${progress.done} of ${progress.total} done`}
              >
                <ListChecksIcon aria-hidden className="size-3" />
                {progress.done}/{progress.total}
              </span>
            ) : null}
            {labels.length > 0 ? (
              <span className="flex min-w-0 items-center gap-1 overflow-hidden">
                {labels.slice(0, MAX_ROW_LABELS).map((label) => (
                  <LabelChip key={label.id} label={label} />
                ))}
                {labels.length > MAX_ROW_LABELS ? (
                  <span className="shrink-0 tabular-nums">+{labels.length - MAX_ROW_LABELS}</span>
                ) : null}
              </span>
            ) : null}
            {card.linkedThreadIds.length > 0 ? (
              <span className="ms-auto inline-flex shrink-0 items-center gap-1">
                {card.linkedThreadIds.slice(0, MAX_ROW_THREADS).map((threadId) => (
                  <LinkedThreadDot
                    key={threadId}
                    environmentId={props.environmentId}
                    threadId={threadId}
                  />
                ))}
              </span>
            ) : null}
          </span>
        </button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Actions for #${card.number}`}
                // Keeps the drag sensors off the menu button.
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              />
            }
          >
            <EllipsisIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => props.onOpen(card)}>
              <PanelRightOpenIcon aria-hidden />
              Open card
            </MenuItem>
            <MenuItem onClick={() => props.onOpenOnBoard(card)}>
              <SquareKanbanIcon aria-hidden />
              Open on board
            </MenuItem>
            {props.canEdit && otherColumns.length > 0 ? (
              <MenuSub>
                <MenuSubTrigger>
                  <ArrowRightLeftIcon aria-hidden />
                  Move to
                </MenuSubTrigger>
                <MenuSubPopup>
                  {otherColumns.map((column) => (
                    <MenuItem key={column.id} onClick={() => props.onMove(column.id)}>
                      <ColorDot color={column.color} />
                      {column.name}
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            ) : null}
            {props.canEdit ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => void actions.archiveCard({ cardId: card.id })}>
                  <ArchiveIcon aria-hidden />
                  Archive
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
});
