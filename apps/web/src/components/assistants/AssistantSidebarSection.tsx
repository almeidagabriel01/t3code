import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  assistantPresence,
  assistantQueuedLabel,
  type AssistantMood,
} from "@t3tools/client-runtime/assistantRobot";
import { assistantEntryKey, assistantSections } from "@t3tools/client-runtime/assistantSections";
import {
  EnvironmentId,
  ProjectId,
  type AssistantTeamId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  SparklesIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import {
  Fragment,
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

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
import { RelativeTime } from "../RelativeTime";
import { SidebarNotificationDot } from "../sidebar/SidebarNotificationDot";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AssistantAvatar } from "./assistantPresentation";
import { openAssistantDialog } from "./assistantDialogState";
import { openAssistantTeamDialog } from "./assistantTeamState";
import { DescribeAssistantDialog } from "./DescribeAssistantDialog";
import { useAssistantFlows } from "./useAssistantFlows";

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
  const presence = assistantPresence(thread);
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

const AssistantRow = memo(function AssistantRow(props: {
  readonly entry: AssistantEntry;
  readonly environmentLabel: string | null;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  /** Named in the status line when the assistant is listed somewhere other than its project. */
  readonly projectLabel?: string | null;
  readonly nested?: boolean;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const { presence, dotClass, open } = useAssistantState(props.entry, props.onOpen);
  const working = presence.mood === "working";
  const queuedLabel = assistantQueuedLabel(presence.queued);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  return (
    <li className={cn("list-none py-0.5", props.nested && "ms-3.5 border-s border-foreground/10")}>
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={`assistant:${environmentId}:${assistant.id}`}
        aria-label={`${assistant.name}${working ? ", working" : ""}`}
        aria-current={props.isActive ? "page" : undefined}
        data-testid="sidebar-assistant-row"
        className={cn(
          "group/sidebar-row flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) py-1 text-left text-sm font-medium text-sidebar-foreground select-none hover:bg-sidebar-row-hover",
          FOCUS_RING,
          props.isActive && "bg-sidebar-row-active",
        )}
        onClick={open}
        onKeyDown={onKeyDown}
      >
        <AssistantAvatar assistant={assistant} mood={presence.mood} className="size-6" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{assistant.name}</span>
            {assistant.role === "" ? null : (
              <Badge variant="outline" size="sm" data-testid="assistant-role">
                <span className="max-w-20 truncate">{assistant.role}</span>
              </Badge>
            )}
            {props.environmentLabel ? (
              <Badge variant="outline" size="sm">
                <span className="max-w-24 truncate">{props.environmentLabel}</span>
              </Badge>
            ) : null}
          </span>
          <span
            data-testid="assistant-status"
            data-mood={presence.mood}
            className={cn("flex min-w-0 text-xs font-normal", MOOD_TEXT[presence.mood])}
          >
            <span className="truncate">
              {props.projectLabel ? `${props.projectLabel} only · ` : ""}
              {presence.detail}
            </span>
            {presence.since === null ? null : (
              <span className="shrink-0 ps-1">
                · <RelativeTime timestamp={presence.since} />
              </span>
            )}
            {queuedLabel === null ? null : (
              <span data-testid="assistant-queued" className="shrink-0 ps-1">
                · {queuedLabel}
              </span>
            )}
          </span>
        </span>
        {working ? <Spinner size="xs" tone="muted" aria-label="Working" /> : null}
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
        <AssistantAvatar assistant={assistant} mood={presence.mood} className="size-5" />
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

const sectionLabelClass = "px-(--sidebar-row-content-inset) pt-2 pb-0.5 text-xs font-medium";

function SectionLabel(props: { readonly children: string; readonly tone?: string }) {
  return (
    <li
      aria-hidden
      className={cn("list-none", sectionLabelClass, props.tone ?? "text-secondary-label")}
    >
      {props.children}
    </li>
  );
}

const MAX_STACKED_AVATARS = 4;

/** A group or project header: folds its members, shows what it holds, and carries its menu. */
function FoldRow(props: {
  readonly foldKey: string;
  readonly label: string;
  readonly folded: boolean;
  readonly onToggle: (foldKey: string) => void;
  readonly leading: ReactNode;
  readonly trailing?: ReactNode;
  readonly menuLabel: string;
  readonly menu: ReactNode;
}) {
  const toggle = () => props.onToggle(props.foldKey);
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!props.folded}
        aria-label={props.label}
        data-testid="sidebar-assistant-fold"
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sm font-semibold text-sidebar-foreground select-none hover:bg-sidebar-row-hover",
          FOCUS_RING,
        )}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 text-muted-foreground", props.folded && "-rotate-90")}
        />
        {props.leading}
        <span className="min-w-0 truncate">{props.label}</span>
        {props.trailing}
        <span className="flex-1" />
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={props.menuLabel}
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
            {props.menu}
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
}

function GroupRow(props: {
  readonly entry: AssistantTeamEntry;
  readonly members: ReadonlyArray<AssistantEntry>;
  readonly folded: boolean;
  readonly onToggle: (foldKey: string) => void;
}) {
  const { environmentId, team } = props.entry;
  const teamId: AssistantTeamId = team.id;
  const shown = props.members.slice(0, MAX_STACKED_AVATARS);
  const more = props.members.length - shown.length;
  return (
    <FoldRow
      foldKey={`group:${environmentId}:${teamId}`}
      label={team.name}
      folded={props.folded}
      onToggle={props.onToggle}
      leading={<UsersIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />}
      trailing={
        <span className="flex items-center ps-0.5" data-testid="group-avatars">
          {shown.map(({ assistant }) => (
            <AssistantAvatar
              key={assistant.id}
              assistant={assistant}
              className="-ms-1 size-4.5 first:ms-0"
            />
          ))}
          {more > 0 ? (
            <span className="ps-1 text-2xs font-normal text-muted-foreground tabular-nums">
              +{more}
            </span>
          ) : null}
        </span>
      }
      menuLabel={`${team.name} actions`}
      menu={
        <>
          <MenuItem onClick={() => openAssistantTeamDialog({ environmentId, teamId })}>
            <PencilIcon />
            Edit group
          </MenuItem>
          <MenuItem onClick={() => openAssistantDialog({ environmentId, preset: { teamId } })}>
            <PlusIcon />
            New assistant in this group
          </MenuItem>
        </>
      }
    />
  );
}

/** Pinned above the project groups: what needs the user, then groups, projects and the rest. */
export const AssistantSidebarSection = memo(function AssistantSidebarSection(props: {
  readonly routeThreadKey: string | null;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { active, teams } = useAssistantEntries();
  const enabled = useClientSettings((settings) => settings.sidebarShowAssistantsSection);
  const collapsed = useClientSettings((settings) => settings.sidebarAssistantsCollapsed);
  const foldedKeys = useClientSettings((settings) => settings.sidebarAssistantsCollapsedGroups);
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const [describing, setDescribing] = useState(false);
  if (!enabled || (active.length === 0 && teams.length === 0)) return null;
  const environmentCount = new Set(active.map((entry) => entry.environmentId)).size;
  const keyOf = (entry: AssistantEntry) =>
    entry.assistant.threadId
      ? scopedThreadKey(scopeThreadRef(entry.environmentId, entry.assistant.threadId))
      : null;
  const strip = active.slice(0, COLLAPSED_AVATARS);
  const overflow = active.length - strip.length;
  const toggle = () => void updateClientSettings({ sidebarAssistantsCollapsed: !collapsed });
  const toggleFold = (foldKey: string) =>
    void updateClientSettings({
      sidebarAssistantsCollapsedGroups: foldedKeys.includes(foldKey)
        ? foldedKeys.filter((key) => key !== foldKey)
        : [...foldedKeys, foldKey],
    });

  const keyByThread = new Map(
    active.flatMap((entry) => {
      const key = keyOf(entry);
      return key === null ? [] : [[key, assistantEntryKey(entry)] as const];
    }),
  );
  const needsKeys = new Set<string>();
  for (const shell of shells) {
    const key = keyByThread.get(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)));
    if (key !== undefined && assistantPresence(shell).mood === "needs") needsKeys.add(key);
  }
  const sections = assistantSections({ assistants: active, teams, needsKeys });
  const projectName = (environmentId: string, projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "Project";

  const row = (
    entry: AssistantEntry,
    extra: { nested?: boolean; projectLabel?: string | null },
  ) => {
    const key = keyOf(entry);
    return (
      <AssistantRow
        key={`${entry.environmentId}:${entry.assistant.id}`}
        entry={entry}
        environmentLabel={
          environmentCount > 1
            ? (props.environmentLabelById.get(entry.environmentId) ?? null)
            : null
        }
        isActive={key !== null && key === props.routeThreadKey}
        onOpen={props.onOpenThread}
        {...extra}
      />
    );
  };
  const projectLabelOf = (entry: AssistantEntry) =>
    entry.assistant.scope === "project"
      ? projectName(entry.environmentId, entry.assistant.projectId)
      : null;

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
            ? strip.map((entry) => {
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
              aria-label={`Show all ${active.length} assistants`}
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
          {sections.needs.length > 0 ? (
            <>
              <SectionLabel tone="text-warning-foreground">{`Needs you · ${sections.needs.length}`}</SectionLabel>
              {sections.needs.map((entry) => row(entry, { projectLabel: projectLabelOf(entry) }))}
            </>
          ) : null}
          {sections.groups.length > 0 ? (
            <>
              <SectionLabel>Groups</SectionLabel>
              {sections.groups.map(({ team, members }) => {
                const folded = foldedKeys.includes(`group:${team.environmentId}:${team.team.id}`);
                return (
                  <Fragment key={`${team.environmentId}:${team.team.id}`}>
                    <GroupRow
                      entry={team}
                      members={members}
                      folded={folded}
                      onToggle={toggleFold}
                    />
                    {folded ? null : members.length === 0 ? (
                      <li className="ms-3.5 list-none border-s border-foreground/10 py-1 ps-3 text-xs text-muted-foreground">
                        No members yet
                      </li>
                    ) : (
                      members.map((entry) =>
                        row(entry, { nested: true, projectLabel: projectLabelOf(entry) }),
                      )
                    )}
                  </Fragment>
                );
              })}
            </>
          ) : null}
          {sections.projects.length > 0 ? (
            <>
              <SectionLabel>Projects</SectionLabel>
              {sections.projects.map((project) => {
                const foldKey = `project:${project.environmentId}:${project.projectId}`;
                const name = projectName(project.environmentId, project.projectId);
                return (
                  <Fragment key={foldKey}>
                    <FoldRow
                      foldKey={foldKey}
                      label={name}
                      folded={foldedKeys.includes(foldKey)}
                      onToggle={toggleFold}
                      leading={
                        <FolderIcon
                          aria-hidden
                          className="size-4 shrink-0 text-(--sidebar-icon-color)"
                        />
                      }
                      menuLabel={`${name} actions`}
                      menu={
                        <MenuItem
                          onClick={() =>
                            openAssistantDialog({
                              environmentId: EnvironmentId.make(project.environmentId),
                              preset: { projectId: ProjectId.make(project.projectId) },
                            })
                          }
                        >
                          <PlusIcon />
                          New assistant in this project
                        </MenuItem>
                      }
                    />
                    {foldedKeys.includes(foldKey)
                      ? null
                      : project.members.map((entry) => row(entry, { nested: true }))}
                  </Fragment>
                );
              })}
            </>
          ) : null}
          {sections.unassigned.length > 0 ? (
            <>
              {sections.needs.length + sections.groups.length + sections.projects.length > 0 ? (
                <SectionLabel>Unassigned</SectionLabel>
              ) : null}
              {sections.unassigned.map((entry) => row(entry, {}))}
            </>
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
