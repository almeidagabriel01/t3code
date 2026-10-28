import type { EnvironmentId, KanbanCard, KanbanCardId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import {
  boardScopeKey,
  collectGlobalBoards,
  collectGlobalCards,
  EMPTY_FILTERS,
  filterGlobalCards,
  groupCardsByProject,
  groupCardsByRole,
  KANBAN_PRIORITIES,
  KANBAN_ROLE_LABELS,
  type GlobalFilters,
} from "./kanban.logic";
import { KanbanBoardView } from "./KanbanBoardView";
import { KanbanCardTile } from "./KanbanCardTile";
import { OptionSelect } from "./kanbanDialogs";
import { useKanbanGlobalLayout } from "./kanbanPreferences";
import { PRIORITY_LABELS } from "./kanbanPresentation";
import { useKanbanCanEdit, type KanbanEnvironmentState } from "./useKanban";

const ANY = "__any__";

function Lane(props: {
  readonly title: string;
  readonly lane: ReturnType<typeof groupCardsByProject>[number];
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  const canEdit = useKanbanCanEdit(props.lane.environmentId);
  const visible = new Set<KanbanCardId>(props.lane.cards.map((entry) => entry.card.id));
  return (
    <section className="grid gap-1" aria-label={props.title}>
      <h2 className="px-4 pt-3 text-sm font-semibold">{props.title}</h2>
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
  readonly projectNames: ReadonlyMap<string, string>;
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  const [filters, setFilters] = useState<GlobalFilters>(EMPTY_FILTERS);
  const [layout, setLayout] = useKanbanGlobalLayout();
  const boards = collectGlobalBoards(props.states);
  const allCards = collectGlobalCards(boards);
  const cards = filterGlobalCards(allCards, boards, filters);
  const nameOf = (environmentId: EnvironmentId, projectId: ProjectId, fallback: string) =>
    props.projectNames.get(boardScopeKey(environmentId, projectId)) ?? fallback;
  const labelNames = [...new Set(boards.flatMap(({ board }) => board.labels.map((l) => l.name)))];
  const typeNames = [...new Set(boards.flatMap(({ board }) => board.templates.map((t) => t.name)))];
  const boardById = new Map(boards.map((entry) => [entry.board.id, entry]));
  const patch = (next: Partial<GlobalFilters>) =>
    setFilters((current) => ({ ...current, ...next }));

  if (boards.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No boards yet. Open a project's board to create one.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Input
          size="sm"
          type="search"
          aria-label="Search cards"
          placeholder="Search cards"
          className="w-48"
          value={filters.text}
          onChange={(event) => patch({ text: event.target.value })}
        />
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" />}>
            Projects{filters.projects.length > 0 ? ` (${filters.projects.length})` : ""}
          </MenuTrigger>
          <MenuPopup align="start">
            {boards.map(({ environmentId, board }) => {
              const key = boardScopeKey(environmentId, board.projectId);
              return (
                <MenuCheckboxItem
                  key={key}
                  checked={filters.projects.includes(key)}
                  onCheckedChange={(checked) =>
                    patch({
                      projects: checked
                        ? [...filters.projects, key]
                        : filters.projects.filter((entry) => entry !== key),
                    })
                  }
                >
                  {nameOf(environmentId, board.projectId, board.title)}
                </MenuCheckboxItem>
              );
            })}
          </MenuPopup>
        </Menu>
        <OptionSelect
          label="Label"
          value={filters.label ?? ANY}
          options={[
            { value: ANY, label: "Any label" },
            ...labelNames.map((v) => ({ value: v, label: v })),
          ]}
          onChange={(value) => patch({ label: value === ANY ? null : value })}
        />
        <OptionSelect
          label="Priority"
          value={filters.priority ?? ANY}
          options={[
            { value: ANY, label: "Any priority" },
            ...KANBAN_PRIORITIES.map((value) => ({
              value: value as string,
              label: PRIORITY_LABELS[value],
            })),
          ]}
          onChange={(value) =>
            patch({ priority: value === ANY ? null : (value as GlobalFilters["priority"]) })
          }
        />
        <OptionSelect
          label="Type"
          value={filters.type ?? ANY}
          options={[
            { value: ANY, label: "Any type" },
            ...typeNames.map((v) => ({ value: v, label: v })),
          ]}
          onChange={(value) => patch({ type: value === ANY ? null : value })}
        />
        <label className="flex items-center gap-1.5 text-sm">
          <Switch
            checked={filters.hasAgent}
            onCheckedChange={(checked) => patch({ hasAgent: Boolean(checked) })}
            aria-label="Has linked agent"
          />
          Has agent
        </label>
        <span className="ms-auto flex gap-1">
          <Button
            size="xs"
            variant={layout === "merged" ? "secondary" : "ghost-muted"}
            onClick={() => setLayout("merged")}
          >
            By status
          </Button>
          <Button
            size="xs"
            variant={layout === "lanes" ? "secondary" : "ghost-muted"}
            onClick={() => setLayout("lanes")}
          >
            By project
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {layout === "merged" ? (
          <div className="flex items-start gap-3 p-4">
            {groupCardsByRole(cards).map((column) => (
              <section
                key={column.role}
                aria-label={KANBAN_ROLE_LABELS[column.role]}
                className="flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 p-2"
              >
                <h3 className="px-1 text-sm font-semibold">
                  {column.role === "none" ? "Other columns" : KANBAN_ROLE_LABELS[column.role]}{" "}
                  <span className="font-normal text-muted-foreground">{column.cards.length}</span>
                </h3>
                {column.cards.map((entry) => {
                  const source = boardById.get(entry.boardId);
                  return (
                    <KanbanCardTile
                      key={entry.card.id}
                      card={entry.card}
                      environmentId={entry.environmentId}
                      labels={source?.board.labels ?? []}
                      templates={source?.board.templates ?? []}
                      projectLabel={nameOf(
                        entry.environmentId,
                        entry.projectId,
                        source?.board.title ?? "",
                      )}
                      onOpen={props.onOpenCard}
                    />
                  );
                })}
              </section>
            ))}
          </div>
        ) : (
          groupCardsByProject(boards, cards).map((lane) => (
            <Lane
              key={lane.key}
              lane={lane}
              title={nameOf(lane.environmentId, lane.board.projectId, lane.board.title)}
              onOpenCard={props.onOpenCard}
            />
          ))
        )}
      </div>
    </div>
  );
}
