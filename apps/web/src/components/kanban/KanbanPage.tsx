import { useNavigate, useSearch } from "@tanstack/react-router";
import { selectKanbanBoardByProject, type KanbanState } from "@t3tools/client-runtime/state/kanban";
import type { EnvironmentId, KanbanCard, ProjectId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { WorkspaceBreadcrumb } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Spinner } from "../ui/spinner";
import {
  boardScopeKey,
  collectGlobalBoards,
  collectGlobalCards,
  findCardInBoards,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { KanbanArchive } from "./KanbanArchive";
import { KanbanBoardView } from "./KanbanBoardView";
import { KanbanCardDetail } from "./KanbanCardDetail";
import { KanbanGlobalBoard } from "./KanbanGlobalBoard";
import { OptionSelect } from "./kanbanDialogs";
import { useKanbanActions, useKanbanCanEdit, useKanbanStates } from "./useKanban";

function Message(props: { readonly title: string; readonly description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ProjectBoard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly state: KanbanState | null;
  readonly focusNewCard: boolean;
  readonly view: "board" | "archive";
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  const { environmentId, state } = props;
  const canEdit = useKanbanCanEdit(environmentId);
  const actions = useKanbanActions(environmentId);
  const board = state === null ? undefined : selectKanbanBoardByProject(state, props.projectId);
  const ensuring = useRef(false);
  const missing = state !== null && board === undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server creates a project's board the first time it is opened
  useEffect(() => {
    if (!missing || !canEdit || ensuring.current) return;
    ensuring.current = true;
    void actions.ensureBoard({ projectId: props.projectId }).finally(() => {
      ensuring.current = false;
    });
  }, [missing, canEdit, actions, props.projectId]);

  if (board === undefined) {
    return state === null ? (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    ) : canEdit ? (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    ) : (
      <Message
        title="No board yet"
        description="This project has no board, and you cannot create one here."
      />
    );
  }
  return props.view === "archive" ? (
    <KanbanArchive
      environmentId={environmentId}
      board={board}
      canEdit={canEdit}
      onOpenCard={props.onOpenCard}
    />
  ) : (
    <KanbanBoardView
      environmentId={environmentId}
      board={board}
      canEdit={canEdit}
      focusNewCard={props.focusNewCard}
      onOpenCard={props.onOpenCard}
    />
  );
}

export function KanbanPage() {
  const search = useSearch({ from: "/_chat/kanban" });
  const navigate = useNavigate({ from: "/kanban" });
  const states = useKanbanStates();
  const groups = useSidebarProjectGroups();
  const [view, setView] = useState<"board" | "archive">("board");
  const [memberKey, setMemberKey] = useState<string | null>(null);
  const [archivedCard, setArchivedCard] = useState<KanbanCard | null>(null);

  const boards = collectGlobalBoards(states);
  const group = search.projectKey
    ? groups.find((entry) => entry.projectKey === search.projectKey)
    : undefined;
  const members = (group?.memberProjects ?? []).filter((member) =>
    states.some((entry) => entry.environmentId === member.environmentId),
  );
  const member = members.find((entry) => entry.physicalProjectKey === memberKey) ?? members[0];
  const projects = new Map(
    groups.flatMap((entry) =>
      entry.memberProjects.map(
        (m) =>
          [
            boardScopeKey(m.environmentId, m.id),
            { name: entry.displayName, projectKey: entry.projectKey, project: m },
          ] as const,
      ),
    ),
  );

  const found = search.card ? findCardInBoards(boards, search.card) : null;
  const memberState =
    member && states.find((entry) => entry.environmentId === member.environmentId)?.state;
  const memberBoard =
    member && memberState ? selectKanbanBoardByProject(memberState, member.id) : undefined;
  const detail =
    found ??
    (archivedCard && member && memberBoard
      ? { environmentId: member.environmentId, board: memberBoard, card: archivedCard }
      : null);
  const detailCanEdit = useKanbanCanEdit(detail?.environmentId ?? null);

  const openCard = (card: KanbanCard) => {
    if (card.archivedAt !== null) setArchivedCard(card);
    else void navigate({ search: (prev) => ({ ...prev, card: card.id }) });
  };
  const closeDetail = () => {
    setArchivedCard(null);
    void navigate({ search: ({ card: _closed, ...rest }) => rest, replace: true });
  };

  const title = group ? `${group.displayName} board` : "Board";
  const subtitle = search.projectKey
    ? null
    : `All projects · ${boards.length} ${boards.length === 1 ? "board" : "boards"} · ${collectGlobalCards(boards).length} cards`;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <WorkspaceBreadcrumb ariaLabel="Board">
          <h1 className="truncate">{title}</h1>
          {subtitle ? (
            <span className="truncate text-xs font-normal text-muted-foreground">{subtitle}</span>
          ) : null}
        </WorkspaceBreadcrumb>
        <div className="ms-auto flex items-center gap-1">
          {members.length > 1 ? (
            <OptionSelect
              label="Environment"
              value={member?.physicalProjectKey ?? ""}
              options={members.map((entry) => ({
                value: entry.physicalProjectKey,
                label: entry.environmentLabel ?? entry.workspaceRoot,
              }))}
              onChange={setMemberKey}
            />
          ) : null}
          {search.projectKey ? (
            <>
              <ToggleGroup
                aria-label="Board view"
                value={[view]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "board" || value === "archive") setView(value);
                }}
              >
                <Toggle value="board">Board</Toggle>
                <Toggle value="archive">Archive</Toggle>
              </ToggleGroup>
              <Button size="xs" variant="ghost-muted" onClick={() => void navigate({ search: {} })}>
                All boards
              </Button>
            </>
          ) : null}
        </div>
      </WorkspacePageHeader>
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden")}>
        {states.length === 0 ? (
          <Message
            title="Boards are not available"
            description="Connect to a T3 Code server that supports boards, with permission to read them."
          />
        ) : search.projectKey ? (
          member === undefined ? (
            <Message
              title="Project not found"
              description="This project is not on a connected environment."
            />
          ) : (
            <ProjectBoard
              key={member.physicalProjectKey}
              environmentId={member.environmentId}
              projectId={member.id}
              state={memberState ?? null}
              focusNewCard={search.new === true}
              view={view}
              onOpenCard={openCard}
            />
          )
        ) : (
          <KanbanGlobalBoard states={states} projects={projects} onOpenCard={openCard} />
        )}
      </div>
      {detail ? (
        <KanbanCardDetail
          key={detail.card.id}
          environmentId={detail.environmentId}
          board={detail.board}
          card={detail.card}
          canEdit={detailCanEdit}
          onOpenCard={openCard}
          onClose={closeDetail}
        />
      ) : null}
    </SidebarInset>
  );
}
