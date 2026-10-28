import type { KanbanCard, KanbanCardId, KanbanColumnRole } from "@t3tools/contracts";
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
import { KanbanCardTile } from "./KanbanCardTile";
import { KanbanGlobalFilters } from "./KanbanGlobalFilters";
import type { KanbanProjectInfo } from "./KanbanProjectBadge";
import { useKanbanGlobalLayout } from "./kanbanPreferences";
import { ColorDot } from "./kanbanPresentation";
import { useKanbanCanEdit, type KanbanEnvironmentState } from "./useKanban";

const ROLE_COLORS: Record<KanbanColumnRole, string> = {
  backlog: "slate",
  todo: "blue",
  "in-progress": "amber",
  review: "violet",
  done: "green",
  none: "slate",
};

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
      <KanbanGlobalFilters
        filters={filters}
        boards={boards}
        projects={props.projects}
        layout={layout}
        onFilters={setFilters}
        onLayout={setLayout}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {layout === "merged" ? (
          <div className="flex h-full w-max min-w-full items-start gap-3 p-4">
            {groupCardsByRole(cards).map((column) => (
              <section
                key={column.role}
                aria-label={KANBAN_ROLE_LABELS[column.role]}
                className="flex max-h-full w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/40 p-2"
              >
                <h3 className="flex items-center gap-1.5 px-1 pt-0.5 text-sm font-semibold">
                  <ColorDot color={ROLE_COLORS[column.role]} />
                  {column.role === "none" ? "Other columns" : KANBAN_ROLE_LABELS[column.role]}
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {column.cards.length}
                  </span>
                </h3>
                <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-0.5">
                  {column.cards.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                      No cards
                    </p>
                  ) : null}
                  {column.cards.map((entry) => {
                    const source = boardById.get(entry.boardId);
                    return (
                      <KanbanCardTile
                        key={entry.card.id}
                        card={entry.card}
                        environmentId={entry.environmentId}
                        labels={source?.board.labels ?? []}
                        templates={source?.board.templates ?? []}
                        project={props.projects.get(
                          boardScopeKey(entry.environmentId, entry.projectId),
                        )}
                        onOpen={props.onOpenCard}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          groupCardsByProject(boards, cards).map((lane) => (
            <Lane
              key={lane.key}
              lane={lane}
              info={props.projects.get(lane.key)}
              onOpenCard={props.onOpenCard}
            />
          ))
        )}
      </div>
    </div>
  );
}
