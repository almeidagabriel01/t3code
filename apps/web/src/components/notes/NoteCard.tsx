import { useAtomValue } from "@effect/atom-react";
import {
  selectKanbanBoardByProject,
  type KanbanBoardState,
  type KanbanState,
} from "@t3tools/client-runtime/state/kanban";
import type { EnvironmentId, KanbanCard, NoteCardLink } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { SquareKanbanIcon, UnlinkIcon } from "lucide-react";

import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { kanbanEnvironment, useKanbanEnvironmentIds } from "../../state/kanban";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const NO_KANBAN_ATOM: Atom.Atom<AsyncResult.AsyncResult<KanbanState, unknown>> = Atom.make(
  AsyncResult.initial<KanbanState, unknown>(false),
).pipe(Atom.withLabel("web-note-card:no-kanban"));

export type NoteCardState =
  | { readonly status: "loading" | "unavailable" | "removed" }
  | {
      readonly status: "found";
      readonly board: KanbanBoardState;
      readonly card: KanbanCard;
      readonly columnName: string | null;
    };

/** The kanban card a note links to, read from the board's live state. */
export function useNoteCard(
  environmentId: EnvironmentId,
  link: NoteCardLink | null,
): NoteCardState {
  const supported = useKanbanEnvironmentIds().includes(environmentId);
  const atom: Atom.Atom<AsyncResult.AsyncResult<KanbanState, unknown>> =
    supported && link !== null
      ? kanbanEnvironment.live({ environmentId, input: null })
      : NO_KANBAN_ATOM;
  const result = useAtomValue(atom);
  if (!supported) return { status: "unavailable" };
  if (link === null) return { status: "removed" };
  const state = Option.getOrNull(AsyncResult.value(result));
  if (state === null || state.sequence === null) return { status: "loading" };
  const board = selectKanbanBoardByProject(state, link.projectId);
  const card = board?.cards.get(link.cardId);
  if (board === undefined || card === undefined) return { status: "removed" };
  return {
    status: "found",
    board,
    card,
    columnName: board.columns.find((column) => column.id === card.columnId)?.name ?? null,
  };
}

/** Opens a card in the board page's card sheet, scoped to its project when the project is known. */
export function useOpenKanbanCard() {
  const navigate = useNavigate();
  const groups = useSidebarProjectGroups();
  return (environmentId: EnvironmentId, card: KanbanCard, projectId: string) => {
    const projectKey = groups.find((group) =>
      group.memberProjects.some(
        (member) => member.environmentId === environmentId && member.id === projectId,
      ),
    )?.projectKey;
    void navigate({
      to: "/kanban",
      search: { card: card.id, ...(projectKey ? { projectKey } : {}) },
    });
  };
}

/** The chip a note shows for its card: number, title, and column, with Unlink. */
export function NoteCardChip(props: {
  environmentId: EnvironmentId;
  link: NoteCardLink;
  canUnlink: boolean;
  onUnlink: () => void;
}) {
  const state = useNoteCard(props.environmentId, props.link);
  const openCard = useOpenKanbanCard();
  if (state.status === "loading") return null;
  const unlink = props.canUnlink ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Unlink card"
            onClick={props.onUnlink}
          />
        }
      >
        <UnlinkIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Unlink the card from this note</TooltipPopup>
    </Tooltip>
  ) : null;
  return (
    <div
      role="group"
      aria-label="Linked card"
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-lg border border-border bg-card py-0.5 ps-2 pe-0.5 text-xs shadow-xs/5"
    >
      <SquareKanbanIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {state.status === "found" ? (
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-sm py-0.5 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          aria-label={`Open card #${state.card.number}, ${state.card.title}`}
          onClick={() => openCard(props.environmentId, state.card, props.link.projectId)}
        >
          <span className="font-medium tabular-nums">#{state.card.number}</span>
          <span className="max-w-64 truncate">{state.card.title}</span>
          {state.card.archivedAt !== null ? (
            <span className="text-muted-foreground">· Archived</span>
          ) : state.columnName ? (
            <span className="text-muted-foreground">· {state.columnName}</span>
          ) : null}
        </button>
      ) : (
        <span className="py-0.5 text-muted-foreground">
          {state.status === "unavailable" ? "Board unavailable here" : "Card removed"}
        </span>
      )}
      {unlink}
    </div>
  );
}
