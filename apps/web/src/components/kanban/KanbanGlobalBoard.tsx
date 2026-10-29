import type {
  KanbanCard,
  KanbanCardId,
  KanbanColumn,
  KanbanColumnId,
  KanbanColumnRole,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { ArrowUpRightIcon, PlusIcon } from "lucide-react";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  boardScopeKey,
  collectGlobalBoards,
  collectGlobalCards,
  EMPTY_FILTERS,
  filterGlobalCards,
  groupCardsByProject,
  groupCardsByRole,
  KANBAN_ROLE_LABELS,
  subtaskTileInfo,
  type GlobalBoard,
  type GlobalFilters,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { KanbanBoardView } from "./KanbanBoardView";
import { KanbanColumnHeader } from "./KanbanColumnHeader";
import { KanbanColumns } from "./KanbanColumns";
import { KanbanQuickEdit, type QuickEditTarget } from "./KanbanQuickEdit";
import { KanbanToolbar } from "./KanbanToolbar";
import { OptionSelect } from "./kanbanDialogs";
import type { KanbanProjectInfo } from "./KanbanProjectBadge";
import { useKanbanGlobalLayout } from "./kanbanPreferences";
import { useKanbanActions, useKanbanCanEdit, type KanbanEnvironmentState } from "./useKanban";

const ROLE_COLORS: Record<KanbanColumnRole, string> = {
  backlog: "slate",
  todo: "blue",
  "in-progress": "amber",
  review: "violet",
  done: "green",
  none: "slate",
};

const noop = () => Promise.resolve();

function Lane(props: {
  readonly lane: ReturnType<typeof groupCardsByProject>[number];
  readonly info: KanbanProjectInfo | undefined;
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  const canEdit = useKanbanCanEdit(props.lane.environmentId);
  const visible = new Set<KanbanCardId>(props.lane.cards.map((entry) => entry.card.id));
  const title = props.info?.name ?? props.lane.board.title;
  return (
    <section className="flex flex-col border-b" aria-label={title}>
      <header className="flex items-center gap-2 px-4 pt-3">
        {props.info ? <ProjectFavicon project={props.info.project} className="size-5" /> : null}
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {props.lane.cards.length} {props.lane.cards.length === 1 ? "card" : "cards"}
        </span>
        {props.info ? (
          <Button
            size="xs"
            variant="ghost-muted"
            className="ms-auto"
            render={<Link to="/kanban" search={{ projectKey: props.info.projectKey }} />}
          >
            Open board
            <ArrowUpRightIcon />
          </Button>
        ) : null}
      </header>
      <div className="h-[26rem]">
        <KanbanBoardView
          environmentId={props.lane.environmentId}
          board={props.lane.board}
          canEdit={canEdit}
          project={props.info}
          visibleCardIds={visible}
          onOpenCard={props.onOpenCard}
        />
      </div>
    </section>
  );
}

/** Picks the project first; a project without a board gets one before the card is added. */
function NewCardDialog(props: {
  readonly boards: ReadonlyArray<GlobalBoard>;
  readonly projects: ReadonlyArray<readonly [string, KanbanProjectInfo]>;
  readonly onClose: () => void;
}) {
  const [projectKey, setProjectKey] = useState(props.projects[0]![0]);
  const [columnId, setColumnId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const info = (props.projects.find(([key]) => key === projectKey) ?? props.projects[0]!)[1];
  const { environmentId, id: projectId } = info.project;
  const actions = useKanbanActions(environmentId);
  const canEdit = useKanbanCanEdit(environmentId);
  const board = props.boards.find(
    (entry) => entry.environmentId === environmentId && entry.board.projectId === projectId,
  )?.board;
  const column =
    board?.columns.find((entry) => entry.id === columnId) ??
    board?.columns.find((entry) => entry.role === "backlog") ??
    board?.columns[0];
  const canSubmit = canEdit && !busy && title.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const boardId = board?.id ?? (await actions.ensureBoard({ projectId }))?.boardId;
    const created =
      boardId === undefined
        ? null
        : await actions.createCard({
            boardId,
            title: title.trim(),
            ...(column ? { columnId: column.id } : {}),
          });
    setBusy(false);
    if (created !== null) props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label>Project</Label>
              <OptionSelect
                label="Project"
                value={projectKey}
                options={props.projects.map(([key, entry]) => ({ value: key, label: entry.name }))}
                onChange={(next) => {
                  setProjectKey(next);
                  setColumnId("");
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Column</Label>
              <OptionSelect
                label="Column"
                value={column?.id ?? ""}
                disabled={board === undefined}
                options={
                  board === undefined
                    ? [{ value: "", label: "Backlog (creates the board)" }]
                    : board.columns.map((entry) => ({ value: entry.id, label: entry.name }))
                }
                onChange={setColumnId}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-new-card-title">Title</Label>
              <Input
                id="kanban-new-card-title"
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  // The selects' hidden inputs block the browser's implicit form submit.
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            Add card
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function KanbanGlobalBoard(props: {
  readonly states: ReadonlyArray<KanbanEnvironmentState>;
  readonly projects: ReadonlyMap<string, KanbanProjectInfo>;
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  const [filters, setFilters] = useState<GlobalFilters>(EMPTY_FILTERS);
  const [layout, setLayout] = useKanbanGlobalLayout();
  const boards = collectGlobalBoards(props.states);
  const allCards = collectGlobalCards(boards);
  const cards = filterGlobalCards(allCards, boards, filters);
  const boardById = new Map(boards.map((entry) => [entry.board.id, entry]));
  const tileInfoByBoard = new Map(
    boards.map((entry) => [entry.board.id, subtaskTileInfo(entry.board)]),
  );
  const [creating, setCreating] = useState(false);
  const [quick, setQuick] = useState<QuickEditTarget | null>(null);
  const quickSource = quick
    ? boards.find((entry) => entry.board.cards.has(quick.cardId))
    : undefined;
  const quickCard = quick ? quickSource?.board.cards.get(quick.cardId) : undefined;
  const connected = new Set(props.states.map((entry) => entry.environmentId));
  const creatable = [...props.projects].filter(([, info]) =>
    connected.has(info.project.environmentId),
  );
  const newCard =
    creatable.length === 0 ? null : (
      <>
        <Button size="xs" variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon />
          New card
        </Button>
        {creating ? (
          <NewCardDialog boards={boards} projects={creatable} onClose={() => setCreating(false)} />
        ) : null}
      </>
    );

  if (boards.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p className="text-sm text-muted-foreground">No boards yet. Add a card to start one.</p>
        {newCard}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <KanbanToolbar
        filters={filters}
        boards={boards}
        projects={props.projects}
        layout={layout}
        onFilters={setFilters}
        onLayout={setLayout}
      >
        {newCard}
      </KanbanToolbar>
      {layout === "merged" ? (
        <div className="min-h-0 flex-1">
          <KanbanColumns
            environmentId={boards[0]!.environmentId}
            columns={groupCardsByRole(cards).map((group) => ({
              column: {
                id: group.role as string as KanbanColumnId,
                name: group.role === "none" ? "Other columns" : KANBAN_ROLE_LABELS[group.role],
                color: ROLE_COLORS[group.role],
                role: "none",
                wipLimit: null,
              } as KanbanColumn,
              cards: group.cards.map((entry) => entry.card),
            }))}
            labels={[]}
            templates={[]}
            canEdit={false}
            tileFor={(card) => {
              const source = boardById.get(card.boardId);
              return {
                ...(source ? tileInfoByBoard.get(source.board.id)?.(card) : undefined),
                environmentId: source?.environmentId ?? boards[0]!.environmentId,
                labels: source?.board.labels ?? [],
                templates: source?.board.templates ?? [],
                showProjectBadge: true,
                onQuickEdit: setQuick,
                project: source
                  ? props.projects.get(boardScopeKey(source.environmentId, source.board.projectId))
                  : undefined,
              };
            }}
            renderHeader={(column, count) => (
              <KanbanColumnHeader
                environmentId={boards[0]!.environmentId}
                column={column}
                siblings={[]}
                count={count}
                canEdit={false}
              />
            )}
            onOpenCard={props.onOpenCard}
            onMoveCard={noop}
            onMoveColumn={noop}
            onAddCard={noop}
          />
          {quick && quickSource && quickCard ? (
            <KanbanQuickEdit
              environmentId={quickSource.environmentId}
              board={quickSource.board}
              card={quickCard}
              anchor={quick.anchor}
              onOpenCard={props.onOpenCard}
              onClose={() => setQuick(null)}
            />
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {groupCardsByProject(boards, cards).map((lane) => (
            <Lane
              key={lane.key}
              lane={lane}
              info={props.projects.get(lane.key)}
              onOpenCard={props.onOpenCard}
            />
          ))}
        </div>
      )}
    </div>
  );
}
