import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { boardScopeKey, resolveKanbanPanelBoard } from "@t3tools/client-runtime/state/kanbanLogic";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanCardId,
  KanbanColumnId,
  ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, Maximize2Icon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useScratchProject } from "../../hooks/useScratchProject";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useProject, useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RightPanelLoading, RightPanelMessage } from "../chat/RightPanelStates";
import { KanbanCardDetail } from "./KanbanCardDetail";
import { KanbanPanelSections } from "./KanbanPanelSections";
import { useKanbanPanelStore } from "./kanbanPanelStore";
import { useKanbanActions, useKanbanCanEdit, useKanbanStates } from "./useKanban";
import { useEnsureKanbanBoard } from "./useKanbanBoardCommands";

/** Which column a new card goes to: a section's own, or the server's default (`null`). */
type Adding = { readonly columnId: KanbanColumnId | null };

export interface KanbanSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** The thread's project board, or the No project board, as stacked sections for the right panel. */
export function KanbanSurface({ environmentId, projectId }: KanbanSurfaceProps) {
  const navigate = useNavigate();
  const canEdit = useKanbanCanEdit(environmentId);
  const actions = useKanbanActions(environmentId);
  const { openScratchProject } = useScratchProject();
  const groups = useSidebarProjectGroups();
  const entry = useKanbanStates().find((state) => state.environmentId === environmentId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const scratch = useProjects().find(
    (candidate) => candidate.environmentId === environmentId && candidate.isScratch === true,
  );
  const projectKey = boardScopeKey(environmentId, projectId);
  const storedScope = useKanbanPanelStore((state) => state.scopeByProject[projectKey]);
  const setScope = useKanbanPanelStore((state) => state.setScope);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [openCardId, setOpenCardId] = useState<KanbanCardId | null>(null);

  const threadIsScratch = project?.isScratch === true;
  const state = entry?.state ?? null;
  const {
    scope,
    ownerId: boardProjectId,
    board,
    createsOnView,
  } = resolveKanbanPanelBoard({
    state,
    projectId,
    threadIsScratch,
    scratchProjectId: scratch?.id ?? null,
    savedScope: storedScope,
  });
  useEnsureKanbanBoard(
    environmentId,
    createsOnView ? projectId : null,
    state !== null && board === undefined,
  );
  const openCard = openCardId === null ? undefined : board?.cards.get(openCardId);

  const sidebarProjectKey = groups.find((group) =>
    group.memberProjects.some(
      (member) => member.environmentId === environmentId && member.id === board?.projectId,
    ),
  )?.projectKey;
  const openOnBoard = (card?: KanbanCard) =>
    void navigate({
      to: "/kanban",
      search: {
        ...(sidebarProjectKey ? { projectKey: sidebarProjectKey } : {}),
        ...(card ? { card: card.id } : {}),
      },
    });

  const createCard = async (title: string, columnId: KanbanColumnId | null) => {
    let boardId = board?.id;
    if (boardId === undefined) {
      const ownerId = boardProjectId ?? (await openScratchProject(environmentId))?.id;
      if (ownerId === undefined) return false;
      boardId = (await actions.ensureBoard({ projectId: ownerId }))?.boardId;
    }
    if (boardId === undefined) return false;
    const created = await actions.createCard({
      boardId,
      title,
      ...(columnId === null ? {} : { columnId }),
    });
    return created !== null;
  };

  const quickAdd = adding ? (
    <KanbanQuickAddRow
      onSubmit={(title) => createCard(title, adding.columnId)}
      onClose={() => setAdding(null)}
    />
  ) : null;

  const body = (() => {
    if (entry === undefined) {
      return (
        <RightPanelMessage
          title="Boards are not available"
          detail="This environment does not support boards, or you cannot read them."
        />
      );
    }
    if (entry.error !== null)
      return <RightPanelMessage title="Could not load the board" detail={entry.error} alert />;
    if (state === null) return <RightPanelLoading label="Loading board…" />;
    if (board === undefined) {
      if (createsOnView) {
        return canEdit ? (
          <RightPanelLoading label="Setting up the board…" />
        ) : (
          <RightPanelMessage
            title="No board yet"
            detail="This project has no board, and you cannot create one here."
          />
        );
      }
      return (
        <>
          {quickAdd}
          <RightPanelMessage
            title="No cards without a project"
            detail={
              canEdit
                ? "Cards you add here belong to no project."
                : "Nobody has added cards without a project yet."
            }
          />
        </>
      );
    }
    return (
      <>
        {adding?.columnId === null ? quickAdd : null}
        <KanbanPanelSections
          environmentId={environmentId}
          board={board}
          canEdit={canEdit}
          onOpenCard={(card) => setOpenCardId(card.id)}
          onOpenOnBoard={openOnBoard}
          onAddCard={(columnId) => setAdding({ columnId })}
          quickAdd={adding?.columnId ? { columnId: adding.columnId, node: quickAdd } : null}
        />
      </>
    );
  })();

  return (
    <div className="@container/kanban-panel flex h-full min-h-0 flex-col">
      <div
        className="flex items-center gap-2 border-b border-foreground/10 px-2 py-2 @md/kanban-panel:px-3"
        data-glass-layer
      >
        {threadIsScratch ? (
          <span className="min-w-0 truncate px-2 text-sm font-medium">No project</span>
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <Button size="xs" variant="ghost" aria-label="Choose board" className="min-w-0" />
              }
            >
              <span className="min-w-0 truncate">
                {scope === "project" ? (project?.title ?? "This project") : "No project"}
              </span>
              <ChevronDownIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="start">
              {(
                [
                  ["project", project?.title ?? "This project"],
                  ["no-project", "No project"],
                ] as const
              ).map(([value, label]) => (
                <MenuItem
                  key={value}
                  onClick={() => {
                    setAdding(null);
                    setScope(projectKey, value);
                  }}
                >
                  {label}
                  {scope === value ? <CheckIcon aria-hidden className="ms-auto" /> : null}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {canEdit && entry !== undefined && state !== null ? (
            <Button size="xs" variant="outline" onClick={() => setAdding({ columnId: null })}>
              <PlusIcon aria-hidden />
              New
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Open the full board"
                  onClick={() => openOnBoard()}
                />
              }
            >
              <Maximize2Icon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Open the full board</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2 @md/kanban-panel:px-2">{body}</div>
      {board && openCard ? (
        <KanbanCardDetail
          key={openCard.id}
          environmentId={environmentId}
          board={board}
          card={openCard}
          canEdit={canEdit}
          onOpenCard={(card) => setOpenCardId(card.id)}
          onClose={() => setOpenCardId(null)}
        />
      ) : null}
    </div>
  );
}

/** Adds cards one after another; Escape or an empty submit closes it. */
function KanbanQuickAddRow(props: {
  readonly onSubmit: (title: string) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      props.onClose();
      return;
    }
    setBusy(true);
    const created = await props.onSubmit(trimmed);
    setBusy(false);
    if (created) setTitle("");
  };
  return (
    <form
      className="flex items-center gap-1.5 px-1 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        autoFocus
        size="sm"
        aria-label="New card title"
        placeholder="Card title"
        value={title}
        disabled={busy}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <Button type="submit" size="xs" disabled={busy}>
        Add
      </Button>
    </form>
  );
}
