import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
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
  KanbanTemplate,
  KanbanTemplateId,
} from "@t3tools/contracts";
import { GripVerticalIcon, PlusIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  applyMoveLocally,
  dropToMove,
  isWipExceeded,
  type CardMove,
  type ColumnCards,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { KanbanCardTile } from "./KanbanCardTile";
import { boardPanRef } from "./boardPan";
import { TemplateIcon } from "./kanbanPresentation";

export interface ColumnWithCards {
  readonly column: KanbanColumn;
  readonly cards: ReadonlyArray<KanbanCard>;
}

const COLUMN_PREFIX = "col:";

const collisionDetection: CollisionDetection = (args) => {
  const isColumn = String(args.active.id).startsWith(COLUMN_PREFIX);
  const droppableContainers = args.droppableContainers.filter(
    (container) => String(container.id).startsWith(COLUMN_PREFIX) === isColumn,
  );
  const next = { ...args, droppableContainers };
  if (isColumn) return closestCenter(next);
  const within = pointerWithin(next);
  return within.length > 0 ? within : closestCenter(next);
};

const SortableCard = memo(function SortableCard(props: {
  readonly card: KanbanCard;
  readonly disabled: boolean;
  readonly tileProps: Omit<Parameters<typeof KanbanCardTile>[0], "card">;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.card.id, disabled: props.disabled });
  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        // Keyboard drags start from the tile itself, so Enter and Space still press its buttons.
        setActivatorNodeRef(node);
      }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <KanbanCardTile card={props.card} {...props.tileProps} />
    </div>
  );
});

type TileProps = Omit<Parameters<typeof KanbanCardTile>[0], "card">;

function ColumnBody(props: {
  readonly column: KanbanColumn;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly disabled: boolean;
  readonly tileOf: (card: KanbanCard) => TileProps;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: props.column.id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-0.5",
        isOver && "bg-accent/50",
      )}
    >
      <SortableContext
        items={props.cards.map((card) => card.id)}
        strategy={verticalListSortingStrategy}
      >
        {props.cards.map((card) => (
          <SortableCard
            key={card.id}
            card={card}
            disabled={props.disabled}
            tileProps={props.tileOf(card)}
          />
        ))}
      </SortableContext>
      {props.cards.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          No cards
        </p>
      ) : null}
    </div>
  );
}

function QuickAdd(props: {
  readonly templates: ReadonlyArray<KanbanTemplate>;
  readonly onAdd: (title: string, type: KanbanTemplateId | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<KanbanTemplateId | null>(null);
  if (!open) {
    return (
      <Button
        variant="ghost-muted"
        size="sm"
        data-quick-add
        aria-label="Add a card"
        className="justify-start"
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
        Add card
      </Button>
    );
  }
  const close = () => {
    setTitle("");
    setType(null);
    setOpen(false);
  };
  return (
    <div
      className="grid gap-1.5"
      onBlur={(event) => {
        if (title.trim().length === 0 && !event.currentTarget.contains(event.relatedTarget)) {
          close();
        }
      }}
    >
      <Input
        size="sm"
        autoFocus
        aria-label="Card title"
        placeholder="Title, then Enter"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          const trimmed = title.trim();
          if (trimmed.length === 0) return;
          props.onAdd(trimmed, type);
          setTitle("");
        }}
      />
      {props.templates.length > 0 ? (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Card template">
          {props.templates.map((template) => (
            <Button
              key={template.id}
              variant={type === template.id ? "secondary" : "ghost-muted"}
              size="xs"
              aria-pressed={type === template.id}
              onClick={() => setType(type === template.id ? null : template.id)}
            >
              <TemplateIcon template={template} />
              {template.name}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SortableColumn(props: {
  readonly entry: ColumnWithCards;
  readonly canEdit: boolean;
  readonly header: ReactNode;
  readonly tileOf: (card: KanbanCard) => TileProps;
  readonly templates: ReadonlyArray<KanbanTemplate>;
  readonly onAddCard: KanbanColumnsProps["onAddCard"];
}) {
  const { column, cards } = props.entry;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `${COLUMN_PREFIX}${column.id}`, disabled: !props.canEdit });
  const exceeded = isWipExceeded(column, cards.length);
  return (
    <section
      ref={setNodeRef}
      data-testid="kanban-column"
      data-column-id={column.id}
      data-wip-exceeded={exceeded || undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/col flex max-h-full w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/40 p-2",
        exceeded && "ring-1 ring-inset ring-warning/40",
        isDragging && "opacity-60",
      )}
    >
      <header className="flex items-center gap-1.5 px-1 pt-0.5">
        {props.canEdit ? (
          <button
            type="button"
            ref={setActivatorNodeRef}
            aria-label={`Reorder column ${column.name}`}
            className="-ms-1 cursor-grab text-muted-foreground opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
        ) : null}
        {props.header}
      </header>
      <ColumnBody column={column} cards={cards} disabled={!props.canEdit} tileOf={props.tileOf} />
      {props.canEdit ? (
        <QuickAdd
          templates={props.templates}
          onAdd={(title, type) => props.onAddCard(column.id, title, type)}
        />
      ) : null}
    </section>
  );
}

export interface KanbanColumnsProps {
  readonly environmentId: EnvironmentId;
  readonly columns: ReadonlyArray<ColumnWithCards>;
  readonly labels: ReadonlyArray<KanbanLabel>;
  readonly templates: ReadonlyArray<KanbanTemplate>;
  readonly canEdit: boolean;
  readonly renderHeader: (column: KanbanColumn, count: number) => ReactNode;
  /** Overrides per card, for boards that mix cards from several boards. */
  readonly tileFor?: ((card: KanbanCard) => Partial<TileProps>) | undefined;
  readonly onOpenCard: (card: KanbanCard) => void;
  readonly onMoveCard: (move: CardMove, from: KanbanColumn, to: KanbanColumn) => Promise<unknown>;
  readonly onMoveColumn: (
    columnId: KanbanColumnId,
    position: { beforeColumnId: KanbanColumnId } | { afterColumnId: KanbanColumnId },
  ) => Promise<unknown>;
  readonly onAddCard: (
    columnId: KanbanColumnId,
    title: string,
    type: KanbanTemplateId | null,
  ) => void;
  readonly onStartAgent?: ((card: KanbanCard) => void) | undefined;
  readonly onLinkThread?: ((card: KanbanCard) => void) | undefined;
  readonly onQuickEdit?: TileProps["onQuickEdit"];
}

interface Optimistic {
  readonly move: CardMove;
  readonly columnId: KanbanColumnId;
  readonly orderKey: string;
}

export function KanbanColumns(props: KanbanColumnsProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null);
  const [optimistic, setOptimistic] = useState<Optimistic | null>(null);

  const displayed = ((): ReadonlyArray<ColumnWithCards> => {
    if (optimistic === null) return props.columns;
    const cards = new Map(props.columns.flatMap((entry) => entry.cards.map((c) => [c.id, c])));
    const live = cards.get(optimistic.move.cardId);
    if (
      live === undefined ||
      live.columnId !== optimistic.columnId ||
      live.orderKey !== optimistic.orderKey
    ) {
      return props.columns;
    }
    const moved = applyMoveLocally(
      props.columns.map((entry) => ({
        columnId: entry.column.id,
        cardIds: entry.cards.map((card) => card.id),
      })),
      optimistic.move,
    );
    return props.columns.map((entry, index) => ({
      column: entry.column,
      cards: moved[index]!.cardIds.map((id) => cards.get(id)!),
    }));
  })();

  const tileProps = {
    environmentId: props.environmentId,
    labels: props.labels,
    templates: props.templates,
    onOpen: props.onOpenCard,
    onStartAgent: props.canEdit ? props.onStartAgent : undefined,
    onLinkThread: props.canEdit ? props.onLinkThread : undefined,
    onQuickEdit: props.onQuickEdit,
  };

  const tileOf = (card: KanbanCard): TileProps => ({ ...tileProps, ...props.tileFor?.(card) });

  const columnCards: ReadonlyArray<ColumnCards> = displayed.map((entry) => ({
    columnId: entry.column.id,
    cardIds: entry.cards.map((card) => card.id),
  }));

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    if (id.startsWith(COLUMN_PREFIX)) return;
    setActiveCard(displayed.flatMap((entry) => entry.cards).find((card) => card.id === id) ?? null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActiveCard(null);
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId.startsWith(COLUMN_PREFIX)) {
      if (!overId.startsWith(COLUMN_PREFIX)) return;
      const ids = displayed.map((entry) => entry.column.id as string);
      const from = ids.indexOf(activeId.slice(COLUMN_PREFIX.length));
      const to = ids.indexOf(overId.slice(COLUMN_PREFIX.length));
      if (from < 0 || to < 0) return;
      const target = overId.slice(COLUMN_PREFIX.length) as KanbanColumnId;
      void props.onMoveColumn(
        activeId.slice(COLUMN_PREFIX.length) as KanbanColumnId,
        from < to ? { afterColumnId: target } : { beforeColumnId: target },
      );
      return;
    }
    const move = dropToMove(activeId as KanbanCardId, overId, columnCards);
    if (move === null) return;
    const live = props.columns
      .flatMap((entry) => entry.cards)
      .find((card) => card.id === move.cardId);
    const from = props.columns.find((entry) => entry.column.id === live?.columnId)?.column;
    const to = props.columns.find((entry) => entry.column.id === move.columnId)?.column;
    if (live === undefined || from === undefined || to === undefined) return;
    setOptimistic({ move, columnId: live.columnId, orderKey: live.orderKey });
    void props.onMoveCard(move, from, to).finally(() => setOptimistic(null));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveCard(null)}
    >
      <SortableContext
        items={displayed.map((entry) => `${COLUMN_PREFIX}${entry.column.id}`)}
        strategy={horizontalListSortingStrategy}
      >
        <div ref={boardPanRef} className="flex h-full items-start gap-3 overflow-x-auto p-4">
          {displayed.map((entry) => (
            <SortableColumn
              key={entry.column.id}
              entry={entry}
              canEdit={props.canEdit}
              header={props.renderHeader(entry.column, entry.cards.length)}
              tileOf={tileOf}
              templates={props.templates}
              onAddCard={props.onAddCard}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeCard ? <KanbanCardTile card={activeCard} {...tileOf(activeCard)} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
