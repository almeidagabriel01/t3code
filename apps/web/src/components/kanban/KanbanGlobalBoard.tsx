import type {
  KanbanCard,
  KanbanCardId,
  KanbanColumn,
  KanbanColumnId,
  KanbanColumnRole,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { ArrowUpRightIcon } from "lucide-react";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  boardScopeKey,
  collectGlobalBoards,
  collectGlobalCards,
  EMPTY_FILTERS,
  filterGlobalCards,
  groupCardsByProject,
  groupCardsByRole,
  KANBAN_ROLE_LABELS,
  type GlobalFilters,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { KanbanBoardView } from "./KanbanBoardView";
import { KanbanColumnHeader } from "./KanbanColumnHeader";
import { KanbanColumns } from "./KanbanColumns";
import { KanbanToolbar } from "./KanbanToolbar";
import type { KanbanProjectInfo } from "./KanbanProjectBadge";
import { useKanbanGlobalLayout } from "./kanbanPreferences";
import { useKanbanCanEdit, type KanbanEnvironmentState } from "./useKanban";

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
          visibleCardIds={visible}
          onOpenCard={props.onOpenCard}
        />
      </div>
    </section>
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

  if (boards.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No boards yet. Open a project's board to create one.
      </p>
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
      />
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
                environmentId: source?.environmentId ?? boards[0]!.environmentId,
                labels: source?.board.labels ?? [],
                templates: source?.board.templates ?? [],
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
