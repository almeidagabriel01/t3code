import { listedProjects } from "@t3tools/client-runtime/assistantSections";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  assistantMetaLabel,
  rankAssistants,
  visibleAssistants,
} from "@t3tools/client-runtime/assistantList";
import {
  assistantGroupThreadsOf,
  assistantPresence,
  assistantFace,
  type AssistantMood,
} from "@t3tools/client-runtime/assistantRobot";
import type { EnvironmentId, AssistantTeamId, ScopedThreadRef } from "@t3tools/contracts";
import {
  ArchiveIcon,
  BriefcaseIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  MessagesSquareIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  HashIcon,
  MailIcon,
  MailOpenIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  SparklesIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { Fragment, memo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import {
  type AssistantEntry,
  type AssistantTeamEntry,
  useAssistantEntries,
} from "../../state/assistants";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarNotificationDotClass, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { SidebarNotificationDot } from "../sidebar/SidebarNotificationDot";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { AssistantAvatar } from "./assistantPresentation";
import { AssistantTaskRows } from "./AssistantTaskRows";
import { openAssistantDialog } from "./assistantDialogState";
import { openAssistantWork } from "./assistantWorkState";
import {
  openAssistantGroupRoutines,
  openAssistantGroupSettings,
  openAssistantTeamDialog,
} from "./assistantTeamState";
import { DescribeAssistantDialog } from "./DescribeAssistantDialog";
import { useAssistantFlows, useAssistantTeamFlows } from "./useAssistantFlows";

const MOOD_TEXT: Record<AssistantMood, string> = {
  idle: "text-muted-foreground",
  working: "text-info-foreground",
  needs: "text-warning-foreground",
  failed: "text-destructive-foreground",
};

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** What a row and a collapsed avatar both show: the presence, the attention dot, and how to open. */
function useAssistantState(entry: AssistantEntry, onOpen: (threadRef: ScopedThreadRef) => void) {
  const { assistant, environmentId } = entry;
  const threadRef =
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId);
  const thread = useThreadShell(threadRef);
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const localLastVisitedAt = useUiStateStore((state) =>
    threadKey === null ? undefined : state.threadLastVisitedAtById[threadKey],
  );
  const shells = useQuietThreadShells();
  const presence = assistantPresence(
    thread,
    assistantGroupThreadsOf(shells, environmentId, assistant.id),
  );
  const dotClass =
    thread === null
      ? null
      : resolveSidebarNotificationDotClass({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
          hasOpenDecision: false,
        });
  const open = () => {
    if (threadRef !== null) onOpen(threadRef);
  };
  return { presence, dotClass, open };
}

const STATUS_DOT: Partial<Record<AssistantMood, string>> = {
  needs: "bg-warning",
  working: "bg-info",
};

const AssistantRow = memo(function AssistantRow(props: {
  readonly entry: AssistantEntry;
  readonly environmentLabel: string | null;
  readonly isActive: boolean;
  /** The open thread, so a task row of it can show as current. */
  readonly activeThreadKey?: string | null;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  /** Shown as a pill when the assistant is project-scoped and has no status to show. */
  readonly projectLabel?: string | null;
  readonly project?: ProjectFaviconProject | undefined;
  readonly nested?: boolean;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const { presence, dotClass, open } = useAssistantState(props.entry, props.onOpen);
  const working = presence.mood === "working";
  const meta = assistantMetaLabel(presence);
  const statusDot = STATUS_DOT[presence.mood];
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  return (
    <li className={cn("list-none py-px", props.nested && "ms-3.5 border-s border-foreground/10")}>
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={`assistant:${environmentId}:${assistant.id}`}
        aria-label={`${assistant.name}${working ? ", working" : ""}`}
        aria-current={props.isActive ? "page" : undefined}
        data-testid="sidebar-assistant-row"
        className={cn(
          "group/sidebar-row flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sm font-medium text-sidebar-foreground select-none hover:bg-sidebar-row-hover",
          FOCUS_RING,
          props.isActive && "bg-sidebar-row-active",
        )}
        onClick={open}
        onKeyDown={onKeyDown}
      >
        <span className="relative inline-flex shrink-0">
          <AssistantAvatar
            assistant={assistant}
            mood={assistantFace(presence)}
            className="size-5"
          />
          {statusDot ? (
            <span
              aria-hidden
              data-testid="assistant-status-dot"
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar",
                statusDot,
              )}
            />
          ) : null}
        </span>
        <span className="max-w-[55%] shrink-0 truncate">{assistant.name}</span>
        {assistant.role === "" ? null : (
          <Badge variant="outline" size="sm" data-testid="assistant-role">
            <span className="max-w-16 truncate">{assistant.role}</span>
          </Badge>
        )}
        {props.environmentLabel ? (
          <Badge variant="outline" size="sm">
            <span className="max-w-24 truncate">{props.environmentLabel}</span>
          </Badge>
        ) : null}
        <span className="flex-1" />
        {meta !== null ? (
          <span
            data-testid="assistant-status"
            data-mood={presence.mood}
            className={cn(
              "min-w-0 max-w-[45%] truncate text-xs font-normal",
              MOOD_TEXT[presence.mood],
            )}
          >
            {meta}
          </span>
        ) : props.projectLabel ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  data-testid="assistant-project"
                  aria-label={`Project: ${props.projectLabel}`}
                  className="inline-flex shrink-0 items-center"
                />
              }
            >
              {props.project ? (
                <ProjectFavicon project={props.project} className="size-4" />
              ) : (
                <FolderIcon aria-hidden className="size-4 text-muted-foreground" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{props.projectLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
        <SidebarNotificationDot dotClass={dotClass} />
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`${assistant.name} actions`}
                      onClick={(event) => event.stopPropagation()}
                    />
                  }
                />
              }
            >
              <EllipsisIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="top">{assistant.name} actions</TooltipPopup>
          </Tooltip>
          <MenuPopup
            align="end"
            // The popup is portaled but its events still bubble to the row, which would open it.
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <MenuItem
              disabled={!flows.canAct || working}
              onClick={() => void flows.reset(assistant, { openAfter: true })}
            >
              <RefreshCwIcon />
              Reset conversation
            </MenuItem>
            <MenuItem
              onClick={() => openAssistantWork({ environmentId, assistantId: assistant.id })}
            >
              <BriefcaseIcon />
              Assistant work
            </MenuItem>
            <MenuItem
              onClick={() => openAssistantDialog({ environmentId, assistantId: assistant.id })}
            >
              <SettingsIcon />
              Assistant settings
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={!flows.canAct} onClick={() => void flows.archive(assistant)}>
              <ArchiveIcon />
              Archive assistant
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <AssistantTaskRows
        entry={props.entry}
        activeThreadKey={props.activeThreadKey}
        onOpen={props.onOpen}
      />
    </li>
  );
});

const COLLAPSED_AVATARS = 5;

/** One assistant in the collapsed strip: its initial, its state, and one click to its chat. */
const AssistantAvatarButton = memo(function AssistantAvatarButton(props: {
  readonly entry: AssistantEntry;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { assistant } = props.entry;
  const { presence, dotClass, open } = useAssistantState(props.entry, props.onOpen);
  const working = presence.mood === "working";
  const label = `Open ${assistant.name}${working ? ", working" : dotClass ? ", unread" : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={props.isActive ? "page" : undefined}
            disabled={assistant.threadId === null}
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
            className={cn(
              "relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default",
              props.isActive && "ring-1 ring-foreground/30",
            )}
          />
        }
      >
        <AssistantAvatar assistant={assistant} mood={assistantFace(presence)} className="size-5" />
        {working ? (
          <span className="absolute -right-0.5 -bottom-0.5 inline-flex rounded-full bg-sidebar">
            <Spinner size="xs" tone="muted" aria-hidden />
          </span>
        ) : (
          <SidebarNotificationDot
            dotClass={dotClass}
            className="absolute top-0 right-0 ring-2 ring-sidebar"
          />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{assistant.name}</TooltipPopup>
    </Tooltip>
  );
});

const MAX_STACKED_AVATARS = 4;

/** One group on one line: opens its chat on click; the chevron shows or hides its members. */
function GroupRow(props: {
  readonly entry: AssistantTeamEntry;
  readonly members: ReadonlyArray<AssistantEntry>;
  readonly running: number;
  readonly expanded: boolean;
  readonly active: boolean;
  readonly onToggle: (foldKey: string) => void;
  readonly onOpen: () => void;
}) {
  const { environmentId, team } = props.entry;
  const teamId: AssistantTeamId = team.id;
  const flows = useAssistantTeamFlows(environmentId);
  const foldKey = `group:${environmentId}:${teamId}`;
  const shown = props.members.slice(0, MAX_STACKED_AVATARS);
  const more = props.members.length - shown.length;
  const unread = team.chat?.unreadCount ?? 0;
  return (
    <li className="list-none py-px">
      <div
        role="button"
        tabIndex={0}
        aria-label={team.name}
        aria-current={props.active ? "page" : undefined}
        data-testid="sidebar-assistant-fold"
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sm font-medium text-sidebar-foreground select-none hover:bg-sidebar-row-hover",
          FOCUS_RING,
          props.active && "bg-sidebar-row-active",
        )}
        onClick={props.onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onOpen();
          }
        }}
      >
        <HashIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        <span className="min-w-0 truncate">{team.name}</span>
        {/* The faces give up width first (shrink-100, clipped) so a narrow row keeps the name readable. */}
        <span
          className="flex min-w-0 shrink-100 items-center overflow-hidden ps-0.5"
          data-testid="group-avatars"
        >
          {shown.map(({ assistant }) => (
            <AssistantAvatar
              key={assistant.id}
              assistant={assistant}
              className="-ms-1 size-4 shrink-0 first:ms-0"
            />
          ))}
          {more > 0 ? (
            <span className="shrink-0 ps-1 text-2xs font-normal text-muted-foreground tabular-nums">
              +{more}
            </span>
          ) : null}
        </span>
        <span className="flex-1" />
        {props.running > 0 ? (
          <span
            data-testid="group-status"
            className="flex shrink-0 items-center gap-1 text-xs font-normal text-info-foreground"
          >
            <Spinner size="xs" tone="muted" aria-hidden />
            {props.running} running
          </span>
        ) : props.members.length === 0 ? (
          <span
            data-testid="group-status"
            className="shrink-0 text-xs font-normal text-muted-foreground"
          >
            empty
          </span>
        ) : null}
        {unread > 0 ? (
          <Badge
            variant="info"
            size="sm"
            data-testid="group-unread"
            aria-label={`${unread} unread`}
          >
            {unread > 99 ? "99+" : unread}
          </Badge>
        ) : null}
        {props.members.length === 0 ? null : (
          <button
            type="button"
            aria-label={`${props.expanded ? "Hide" : "Show"} ${team.name} members`}
            aria-expanded={props.expanded}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle(foldKey);
            }}
            className={cn(
              "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
              FOCUS_RING,
            )}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3", !props.expanded && "-rotate-90")}
            />
          </button>
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`${team.name} actions`}
                onClick={(event) => event.stopPropagation()}
              />
            }
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup
            align="end"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <MenuItem onClick={props.onOpen}>
              <MessagesSquareIcon />
              Open chat
            </MenuItem>
            {unread > 0 ? (
              <MenuItem disabled={!flows.canMarkRead} onClick={() => void flows.markRead(team)}>
                <MailOpenIcon />
                Mark as read
              </MenuItem>
            ) : (
              <MenuItem
                disabled={!flows.canMarkRead || (team.chat?.latestSeq ?? 0) === 0}
                onClick={() => void flows.markUnread(team)}
              >
                <MailIcon />
                Mark as unread
              </MenuItem>
            )}
            <MenuItem onClick={() => openAssistantTeamDialog({ environmentId, teamId })}>
              <PencilIcon />
              Edit group
            </MenuItem>
            <MenuItem onClick={() => openAssistantGroupSettings({ environmentId, teamId })}>
              <SettingsIcon />
              Group settings
            </MenuItem>
            <MenuItem onClick={() => openAssistantGroupRoutines({ environmentId, teamId })}>
              <CalendarClockIcon />
              Group routines
            </MenuItem>
            <MenuItem onClick={() => openAssistantDialog({ environmentId, preset: { teamId } })}>
              <PlusIcon />
              New assistant in this group
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={!flows.canAct} onClick={() => void flows.archive(team)}>
              <ArchiveIcon />
              Archive group
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
}

/** Pinned above the projects: every group on a row, then one flat list of assistants. */
export const AssistantSidebarSection = memo(function AssistantSidebarSection(props: {
  readonly routeThreadKey: string | null;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
  readonly onOpenGroup: (environmentId: EnvironmentId, teamId: AssistantTeamId) => void;
}) {
  const { active, activeTeams: teams } = useAssistantEntries();
  const routeEnvironmentId = useParams({ strict: false, select: (params) => params.environmentId });
  const routeTeamId = useParams({ strict: false, select: (params) => params.teamId });
  const enabled = useClientSettings((settings) => settings.sidebarShowAssistantsSection);
  const collapsed = useClientSettings((settings) => settings.sidebarAssistantsCollapsed);
  const expandedKeys = useClientSettings((settings) => settings.sidebarAssistantsExpandedGroups);
  const showAll = useClientSettings((settings) => settings.sidebarAssistantsShowAll);
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const [describing, setDescribing] = useState(false);
  if (!enabled || (active.length === 0 && teams.length === 0)) return null;
  const environmentCount = new Set(active.map((entry) => entry.environmentId)).size;
  const ranked = rankAssistants(active, shells);
  const strip = ranked.slice(0, COLLAPSED_AVATARS);
  const overflow = ranked.length - strip.length;
  const { shown, hidden } = visibleAssistants(ranked, showAll);
  const foldable = showAll || hidden > 0;
  const toggle = () => void updateClientSettings({ sidebarAssistantsCollapsed: !collapsed });
  const toggleExpanded = (foldKey: string) =>
    void updateClientSettings({
      sidebarAssistantsExpandedGroups: expandedKeys.includes(foldKey)
        ? expandedKeys.filter((key) => key !== foldKey)
        : [...expandedKeys, foldKey],
    });
  const rankedByKey = new Map(
    ranked.map((item) => [`${item.entry.environmentId}:${item.entry.assistant.id}`, item]),
  );
  const projectOf = (environmentId: string, projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId);
  const keyOf = (entry: AssistantEntry) =>
    entry.assistant.threadId
      ? scopedThreadKey(scopeThreadRef(entry.environmentId, entry.assistant.threadId))
      : null;

  const row = (entry: AssistantEntry, nested = false) => {
    const key = keyOf(entry);
    return (
      <AssistantRow
        key={`${entry.environmentId}:${entry.assistant.id}`}
        entry={entry}
        nested={nested}
        environmentLabel={
          environmentCount > 1
            ? (props.environmentLabelById.get(entry.environmentId) ?? null)
            : null
        }
        projectLabel={
          entry.assistant.scope === "project"
            ? listedProjects(entry.assistant)
                .map((projectId) => projectOf(entry.environmentId, projectId)?.title ?? "Project")
                .join(", ")
            : null
        }
        project={
          entry.assistant.scope === "project"
            ? projectOf(entry.environmentId, entry.assistant.projectId)
            : undefined
        }
        isActive={key !== null && key === props.routeThreadKey}
        activeThreadKey={props.routeThreadKey}
        onOpen={props.onOpenThread}
      />
    );
  };

  return (
    <>
      <li
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={`Assistants, ${active.length}`}
        data-sidebar-row="section:assistants"
        className={cn(
          "flex h-7 cursor-pointer list-none items-center gap-1 rounded-md px-(--sidebar-row-content-inset) hover:bg-sidebar-row-hover",
          FOCUS_RING,
        )}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          toggle();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <UserRoundIcon aria-hidden className="size-3.5 shrink-0 text-(--sidebar-icon-color)" />
        <span className="shrink-0 truncate text-xs font-medium text-secondary-label">
          Assistants
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-0.5 ps-1.5">
          {collapsed
            ? strip.map(({ entry }) => {
                const key = keyOf(entry);
                return (
                  <AssistantAvatarButton
                    key={`${entry.environmentId}:${entry.assistant.id}`}
                    entry={entry}
                    isActive={key !== null && key === props.routeThreadKey}
                    onOpen={props.onOpenThread}
                  />
                );
              })
            : null}
          {collapsed && overflow > 0 ? (
            <button
              type="button"
              aria-label={`Show all ${ranked.length} assistants`}
              onClick={toggle}
              className={cn(
                "inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md px-1 text-2xs text-muted-foreground tabular-nums hover:bg-foreground/8 hover:text-foreground",
                FOCUS_RING,
              )}
            >
              +{overflow}
            </button>
          ) : null}
        </span>
        {collapsed ? null : (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Add"
                  className={cn(
                    "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
                    FOCUS_RING,
                  )}
                />
              }
            >
              <PlusIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup
              align="end"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <MenuItem onClick={() => openAssistantDialog()}>
                <PlusIcon />
                New assistant
              </MenuItem>
              <MenuItem onClick={() => openAssistantTeamDialog()}>
                <UsersIcon />
                New group
              </MenuItem>
              <MenuItem onClick={() => setDescribing(true)}>
                <SparklesIcon />
                Describe one and let T3 build it
              </MenuItem>
            </MenuPopup>
          </Menu>
        )}
        <button
          type="button"
          aria-label={collapsed ? "Expand assistants" : "Collapse assistants"}
          aria-expanded={!collapsed}
          onClick={toggle}
          className={cn(
            "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground",
            FOCUS_RING,
          )}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0", !collapsed && "rotate-90")}
          />
        </button>
      </li>
      {collapsed ? null : (
        <>
          {teams.map((team) => {
            const foldKey = `group:${team.environmentId}:${team.team.id}`;
            const members = team.team.memberIds.flatMap((id) => {
              const item = rankedByKey.get(`${team.environmentId}:${id}`);
              return item === undefined ? [] : [item];
            });
            const expanded = expandedKeys.includes(foldKey);
            return (
              <Fragment key={foldKey}>
                <GroupRow
                  entry={team}
                  members={members.map((item) => item.entry)}
                  running={members.filter((item) => item.presence.mood === "working").length}
                  expanded={expanded}
                  active={routeTeamId === team.team.id && routeEnvironmentId === team.environmentId}
                  onToggle={toggleExpanded}
                  onOpen={() => props.onOpenGroup(team.environmentId, team.team.id)}
                />
                {expanded ? members.map((item) => row(item.entry, true)) : null}
              </Fragment>
            );
          })}
          {shown.map((item) => row(item.entry))}
          {foldable ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() => void updateClientSettings({ sidebarAssistantsShowAll: !showAll })}
                className={cn(
                  "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                  FOCUS_RING,
                )}
              >
                <ChevronDownIcon
                  aria-hidden
                  className={cn("size-3 shrink-0", showAll && "rotate-180")}
                />
                {showAll ? "Show less" : `Show all (${ranked.length})`}
              </button>
            </li>
          ) : null}
        </>
      )}
      <DescribeAssistantDialog open={describing} onOpenChange={setDescribing} />
      <li
        aria-hidden
        data-testid="sidebar-assistants-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});
