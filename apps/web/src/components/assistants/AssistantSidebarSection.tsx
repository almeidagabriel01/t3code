import { useAtomValue } from "@effect/atom-react";
import { teamsEnvironmentLabels } from "@t3tools/client-runtime/assistantProjectAccess";
import type { AssistantMood } from "@t3tools/client-runtime/assistantRobot";
import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { zoneIndicatorLabel, type ZoneIndicator } from "@t3tools/client-runtime/sidebarZones";
import type { EnvironmentId, AssistantTeamId, ScopedThreadRef } from "@t3tools/contracts";
import {
  ArchiveIcon,
  BriefcaseIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CirclePauseIcon,
  ClockAlertIcon,
  EllipsisIcon,
  InfoIcon,
  MailIcon,
  MailOpenIcon,
  MessageCircleQuestionIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { memo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { updateClientSettings } from "../../hooks/useSettings";
import type { AssistantEntry, AssistantTeamEntry } from "../../state/assistants";
import { useThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarNotificationDotClass, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { SidebarNotificationDot } from "../sidebar/SidebarNotificationDot";
import { SubagentRows } from "../sidebar/SidebarSubagentRows";
import { JumpHintBadge } from "../sidebar/JumpHintBadge";
import { settingsScopeEnvironmentAddress } from "../settings/settingsScopeAxis";
import { startThreadDrag } from "../threadDrag";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openAssistantInfo } from "./assistantInfoState";
import { AssistantAvatar, AssistantCluster } from "./assistantPresentation";
import {
  assistantFoldKey,
  AssistantTaskRows,
  type AssistantTaskRowRenderer,
} from "./AssistantTaskRows";
import { openAssistantDialog } from "./assistantDialogState";
import { openAssistantWork } from "./assistantWorkState";
import {
  openAssistantGroupRoutines,
  openAssistantGroupSettings,
  openAssistantTeamDialog,
} from "./assistantTeamState";
import { DescribeAssistantDialog } from "./DescribeAssistantDialog";
import { useAssistantFlows, useAssistantTeamFlows } from "./useAssistantFlows";
import {
  sameItem,
  type AssistantSidebarItem,
  type AssistantSidebarModel,
} from "./useAssistantSidebarModel";

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const ICON_BUTTON = cn(
  "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
  FOCUS_RING,
);

type IndicatorKind = ZoneIndicator["kind"];

const indicatorLabel = (kind: IndicatorKind, count: number, subject: "assistant" | "group") =>
  zoneIndicatorLabel({ kind, count } as ZoneIndicator, subject);

const INDICATOR_ICON = {
  needs: MessageCircleQuestionIcon,
  running: CircleDashedIcon,
  failed: CircleAlertIcon,
  limited: ClockAlertIcon,
  paused: CirclePauseIcon,
  unread: MailIcon,
} as const;

const INDICATOR_TONE = {
  needs: "text-warning-foreground",
  running: "text-info-foreground",
  failed: "text-destructive-foreground",
  limited: "text-warning-foreground",
  paused: "text-warning-foreground",
  unread: "text-info-foreground",
} as const;

const INDICATOR_DOT = {
  needs: "bg-warning",
  running: "bg-info",
  failed: "bg-destructive",
  limited: "bg-warning",
  paused: "bg-muted-foreground",
  unread: "bg-info",
} as const;

/** A row's one status, drawn still: a dot or an icon, and the count as text. */
function ZoneIndicatorMark(props: { readonly kind: IndicatorKind; readonly count: number }) {
  const { kind, count } = props;
  const label = indicatorLabel(kind, count, "assistant");
  if (kind === "unread") {
    return (
      <Badge
        variant="info"
        size="sm"
        data-testid="zone-indicator"
        data-kind={kind}
        aria-label={label}
      >
        {count > 99 ? "99+" : count}
      </Badge>
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      data-testid="zone-indicator"
      data-kind={kind}
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs font-normal tabular-nums",
        kind === "needs" && "text-warning-foreground",
        kind === "failed" && "text-destructive-foreground",
        (kind === "paused" || kind === "limited") && "text-warning-foreground",
        kind === "running" && "text-info-foreground",
      )}
    >
      {kind === "failed" ? (
        <CircleAlertIcon aria-hidden className="size-3.5" />
      ) : kind === "paused" ? (
        <CirclePauseIcon aria-hidden className="size-3.5" />
      ) : kind === "limited" ? (
        <ClockAlertIcon aria-hidden className="size-3.5" />
      ) : (
        <span
          aria-hidden
          className={cn("size-2 rounded-full", kind === "needs" ? "bg-warning" : "bg-info")}
        />
      )}
      {kind === "failed" || kind === "limited" || (kind === "running" && count === 1)
        ? null
        : count}
    </span>
  );
}

type SubagentContextMenu = (
  threadRef: ScopedThreadRef,
  position: { readonly x: number; readonly y: number },
) => void;

type RevealRow = (row: HTMLElement, threadKey: string) => void;

/** The model rebuilds each item on every derivation, so the row compares it by content. */
function sameAssistantRowProps(previous: AssistantRowProps, next: AssistantRowProps): boolean {
  return (Object.keys(next) as Array<keyof AssistantRowProps>).every((key) => {
    if (key === "item") return sameItem(previous.item, next.item);
    if (key === "reveal") {
      return (
        previous.reveal === next.reveal ||
        (previous.reveal !== undefined &&
          next.reveal !== undefined &&
          previous.reveal.key === next.reveal.key &&
          previous.reveal.subagentKey === next.reveal.subagentKey &&
          previous.reveal.row === next.reveal.row)
      );
    }
    return Object.is(previous[key], next[key]);
  });
}

interface AssistantRowProps {
  readonly entry: AssistantEntry;
  readonly mood: AssistantMood;
  readonly indicatorKind: IndicatorKind | null;
  readonly indicatorCount: number;
  readonly item: AssistantSidebarItem;
  readonly nested: boolean;
  readonly environmentLabel: string | null;
  readonly isActive: boolean;
  /** The open thread, so a task row of it shows as current; set only on a row with tasks. */
  readonly activeThreadKey: string | null;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  readonly jumpLabelByKey: ReadonlyMap<string, string> | null | undefined;
  /** Set only on a row with tasks, so a new renderer never re-renders the others. */
  readonly renderTaskRow?: AssistantTaskRowRenderer | undefined;
  readonly onThreadContextMenu?: SubagentContextMenu | undefined;
  /** Set only on the row that stands for the open thread: its chat, or one of its subagents. */
  readonly reveal?:
    | { readonly row: RevealRow; readonly key: string; readonly subagentKey: string | null }
    | undefined;
}

const AssistantRow = memo(function AssistantRow(props: AssistantRowProps) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const threadRef =
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId);
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const thread = useThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore((state) =>
    threadKey === null ? undefined : state.threadLastVisitedAtById[threadKey],
  );
  // Unread news shows only when the row has no status, so a row never carries two marks.
  const dotClass =
    thread === null || props.indicatorKind !== null
      ? null
      : resolveSidebarNotificationDotClass({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
          hasOpenDecision: false,
        });
  const open = () => {
    if (threadRef !== null) props.onOpen(threadRef);
  };
  const jumpLabel = threadKey === null ? null : (props.jumpLabelByKey?.get(threadKey) ?? null);
  const { sections, expanded, subagents } = props.item;
  // Folds persist beside the project folds, under a key no project can take.
  const foldKey = assistantFoldKey(props.entry);
  const setExpanded = useUiStateStore((state) => state.setProjectExpanded);
  // Right-click opens the row's own menu, anchored to its ⋯ button.
  const [menuOpen, setMenuOpen] = useState(false);
  const foldable =
    sections.pinned.length +
      sections.open.length +
      sections.snoozed.length +
      sections.settled.length +
      subagents.length >
    0;
  const working = props.mood === "working";
  const fullName = [assistant.name, assistant.role, props.environmentLabel]
    .filter(Boolean)
    .join(" · ");
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  const reveal = props.reveal;
  return (
    <li
      className={cn(
        "@container/assistant-row list-none py-px",
        props.nested && "ms-3.5 border-s border-foreground/10",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="button"
              tabIndex={0}
              ref={
                reveal !== undefined && reveal.subagentKey === null
                  ? (row) => {
                      if (row !== null) reveal.row(row, reveal.key);
                    }
                  : undefined
              }
              data-sidebar-row={foldKey}
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
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuOpen(true);
              }}
              onPointerDown={(event) => {
                if (threadRef === null || (event.target as HTMLElement).closest("button")) return;
                startThreadDrag(event.nativeEvent, threadRef, assistant.name);
              }}
            />
          }
        >
          <AssistantAvatar assistant={assistant} mood={props.mood} className="size-5 shrink-0" />
          {/* The role keeps 3rem or wraps onto the clipped second line, never showing as a sliver. */}
          <span className="flex h-5 min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 overflow-hidden">
            <span className="max-w-full shrink-0 truncate">{assistant.name}</span>
            {assistant.role === "" ? null : (
              <span
                data-testid="assistant-role"
                className="min-w-12 flex-1 truncate text-xs font-normal text-muted-foreground @max-[14rem]/assistant-row:hidden"
              >
                {assistant.role}
              </span>
            )}
          </span>
          {props.indicatorKind === null ? null : (
            <ZoneIndicatorMark kind={props.indicatorKind} count={props.indicatorCount} />
          )}
          <SidebarNotificationDot dotClass={dotClass} />
          {jumpLabel ? <JumpHintBadge label={jumpLabel} /> : null}
          {foldable ? (
            <button
              type="button"
              aria-label={`${expanded ? "Hide" : "Show"} ${assistant.name} tasks`}
              aria-expanded={expanded}
              data-testid="assistant-fold"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded(foldKey, !expanded);
              }}
              className={ICON_BUTTON}
            >
              <ChevronDownIcon aria-hidden className={cn("size-3", !expanded && "-rotate-90")} />
            </button>
          ) : null}
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`${assistant.name} actions`}
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <EllipsisIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup
              align="end"
              // The popup is portaled but its events still bubble to the row, which would open it.
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <MenuItem
                onClick={() =>
                  openAssistantInfo({ kind: "assistant", environmentId, assistantId: assistant.id })
                }
              >
                <InfoIcon />
                Assistant info
              </MenuItem>
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
        </TooltipTrigger>
        <TooltipPopup side="top">{fullName}</TooltipPopup>
      </Tooltip>
      {expanded ? (
        <>
          <AssistantTaskRows
            entry={props.entry}
            sections={sections}
            activeThreadKey={props.activeThreadKey}
            onOpen={props.onOpen}
            renderRow={props.renderTaskRow}
          />
          {subagents.length > 0 ? (
            <ul aria-label={`${assistant.name} subagents`} className="m-0 p-0">
              <SubagentRows
                onOpen={props.onOpen}
                onContextMenu={props.onThreadContextMenu}
                jumpLabelByKey={props.jumpLabelByKey}
                reveal={
                  reveal !== undefined && reveal.subagentKey !== null
                    ? { row: reveal.row, key: reveal.key, threadKey: reveal.subagentKey }
                    : undefined
                }
              >
                {subagents}
              </SubagentRows>
            </ul>
          ) : null}
        </>
      ) : null}
    </li>
  );
}, sameAssistantRowProps);

/** A group's faces with its status as a still dot in the corner; dashed when it has no members. */
function GroupMark(props: {
  readonly environmentId: EnvironmentId;
  readonly members: ReadonlyArray<AssistantEntry>;
  readonly kind: IndicatorKind | null;
}) {
  if (props.members.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label="No members yet"
              data-testid="group-status"
              className="size-5 shrink-0 rounded-md border border-dashed border-foreground/24"
            />
          }
        />
        <TooltipPopup side="top">No members yet</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <span data-testid="group-mark" className="relative flex shrink-0">
      <AssistantCluster
        faces={props.members.map(({ assistant }) => ({ key: assistant.id, assistant }))}
        environmentId={props.environmentId}
      />
      {props.kind === null ? null : (
        <span
          aria-hidden
          data-testid="group-dot"
          data-kind={props.kind}
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar",
            INDICATOR_DOT[props.kind],
          )}
        />
      )}
    </span>
  );
}

/** A group's one status: icon and words, or the icon alone with its words in a tooltip when narrow. */
function FolderIndicator(props: { readonly kind: IndicatorKind; readonly count: number }) {
  const label = indicatorLabel(props.kind, props.count, "group");
  const Icon = INDICATOR_ICON[props.kind];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            data-testid="zone-indicator"
            data-kind={props.kind}
            className={cn(
              "flex min-w-0 shrink-0 items-center gap-1 text-xs font-normal tabular-nums",
              INDICATOR_TONE[props.kind],
            )}
          />
        }
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span aria-hidden className="hidden whitespace-nowrap @[16rem]/folder:inline">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Members arrive in a fresh array on every update; the row redraws only when one of them changes. */
function sameFolderProps<P extends { readonly members: ReadonlyArray<AssistantEntry> }>(
  a: P,
  b: P,
) {
  return (Object.keys(a) as Array<keyof P>).every((key) =>
    key === "members"
      ? a.members.length === b.members.length &&
        a.members.every((member, index) => member.assistant === b.members[index]!.assistant)
      : a[key] === b[key],
  );
}

/** A group as a folder: the chevron shows its members, the name opens its chat. */
const FolderRow = memo(function FolderRow(props: {
  readonly entry: AssistantTeamEntry;
  readonly members: ReadonlyArray<AssistantEntry>;
  readonly expanded: boolean;
  readonly indicatorKind: IndicatorKind | null;
  readonly indicatorCount: number;
  readonly active: boolean;
  readonly onToggle: (foldKey: string) => void;
  readonly onOpenGroup: (environmentId: EnvironmentId, teamId: AssistantTeamId) => void;
}) {
  const { environmentId, team } = props.entry;
  const teamId: AssistantTeamId = team.id;
  const flows = useAssistantTeamFlows(environmentId);
  const foldKey = `group:${environmentId}:${teamId}`;
  const unread = team.chat?.unreadCount ?? 0;
  const open = () => props.onOpenGroup(environmentId, teamId);
  const empty = props.members.length === 0;
  return (
    <li className="list-none py-px">
      <div
        data-testid="sidebar-assistant-fold"
        className={cn(
          "@container/folder flex h-8 w-full items-center gap-1 rounded-md ps-1 pe-(--sidebar-row-content-inset) text-sm font-medium text-sidebar-foreground hover:bg-sidebar-row-hover",
          props.active && "bg-sidebar-row-active",
        )}
      >
        {empty ? (
          <span aria-hidden className="size-5 shrink-0" />
        ) : (
          <button
            type="button"
            aria-label={`${props.expanded ? "Hide" : "Show"} ${team.name} members`}
            aria-expanded={props.expanded}
            data-testid="group-fold"
            onClick={() => props.onToggle(foldKey)}
            className={ICON_BUTTON}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5", props.expanded && "rotate-90")}
            />
          </button>
        )}
        <GroupMark
          environmentId={environmentId}
          members={props.members}
          kind={props.indicatorKind}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-current={props.active ? "page" : undefined}
                data-testid="group-name"
                onClick={open}
                className={cn(
                  "flex h-7 min-w-0 flex-1 cursor-pointer items-center rounded-md px-1 text-left select-none",
                  FOCUS_RING,
                )}
              />
            }
          >
            <span className="min-w-0 truncate">{team.name}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">{team.name}</TooltipPopup>
        </Tooltip>
        {props.indicatorKind === null ? null : (
          <FolderIndicator kind={props.indicatorKind} count={props.indicatorCount} />
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button size="icon-xs" variant="ghost-muted" aria-label={`${team.name} actions`} />
            }
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={open}>
              <MessagesSquareIcon />
              Open chat
            </MenuItem>
            <MenuItem onClick={() => openAssistantInfo({ kind: "group", environmentId, teamId })}>
              <InfoIcon />
              Group info
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
}, sameFolderProps);

const toggleGroup = (expandedKeys: ReadonlyArray<string>, foldKey: string) =>
  void updateClientSettings({
    sidebarAssistantsExpandedGroups: expandedKeys.includes(foldKey)
      ? expandedKeys.filter((key) => key !== foldKey)
      : [...expandedKeys, foldKey],
  });

/** The Teams zone: ungrouped assistants first, then one folder per group, each assistant once. */
export const AssistantSidebarSection = memo(function AssistantSidebarSection(props: {
  readonly model: AssistantSidebarModel;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  /** The open thread's key. */
  readonly routeThreadKey: string | null;
  /** The key of the row that stands for the open thread (a subagent's listed ancestor). */
  readonly routeRowThreadKey?: string | null | undefined;
  /** Scrolls the row that stands for the open thread into view once. */
  readonly revealRow?: RevealRow | undefined;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
  readonly onOpenGroup: (environmentId: EnvironmentId, teamId: AssistantTeamId) => void;
  /** ⌘1–9 labels by thread key while the hints show. */
  readonly jumpLabelByKey?: ReadonlyMap<string, string> | null | undefined;
  readonly renderTaskRow?: AssistantTaskRowRenderer | undefined;
  readonly onThreadContextMenu?: SubagentContextMenu | undefined;
}) {
  const { enabled, collapsed, expandedGroups, count, empty, rows } = props.model;
  const routeEnvironmentId = useParams({ strict: false, select: (params) => params.environmentId });
  const routeTeamId = useParams({ strict: false, select: (params) => params.teamId });
  const [describing, setDescribing] = useState(false);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  if (!enabled || empty) return null;
  const environmentLabel = teamsEnvironmentLabels(
    props.model.entries,
    new Map(
      [...props.environmentLabelById].map(([id, label]) => {
        const environmentId = id as EnvironmentId;
        const entry = catalog.entries.get(environmentId);
        const displayUrl = entry === undefined ? null : connectionCatalogDisplayUrl(entry);
        return [
          environmentId,
          { label, address: settingsScopeEnvironmentAddress({ environmentId, label, displayUrl }) },
        ] as const;
      }),
    ),
  );
  const routeRowThreadKey = props.routeRowThreadKey ?? props.routeThreadKey;
  const toggle = () => void updateClientSettings({ sidebarAssistantsCollapsed: !collapsed });
  const onToggleGroup = (foldKey: string) => toggleGroup(expandedGroups, foldKey);

  const revealFor = (row: Extract<(typeof rows)[number], { kind: "assistant" }>) => {
    const { entry, item } = row;
    if (props.revealRow === undefined || routeRowThreadKey === null) return undefined;
    const chatKey =
      entry.assistant.threadId === null
        ? null
        : scopedThreadKey(scopeThreadRef(entry.environmentId, entry.assistant.threadId));
    if (chatKey !== routeRowThreadKey) return undefined;
    // An open subagent is drawn under its assistant; that row reveals instead of the chat's.
    const subagentKey =
      item.expanded &&
      props.routeThreadKey !== routeRowThreadKey &&
      item.subagents.some(
        (thread) => `${thread.environmentId}:${thread.id}` === props.routeThreadKey,
      )
        ? props.routeThreadKey
        : null;
    return { row: props.revealRow, key: routeRowThreadKey, subagentKey };
  };
  const hasTasks = (item: AssistantSidebarItem) =>
    item.sections.pinned.length +
      item.sections.open.length +
      item.sections.snoozed.length +
      item.sections.settled.length >
    0;

  return (
    <>
      <li
        className="flex list-none items-center gap-1 px-(--sidebar-row-content-inset) pt-3 pb-1"
        data-sidebar-row="section:assistants"
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Teams, ${count}. Expand` : "Collapse teams"}
          onClick={toggle}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md text-left text-xs font-medium text-secondary-label hover:text-foreground",
            FOCUS_RING,
          )}
        >
          <span className="truncate">Teams</span>
          {collapsed ? (
            <span className="shrink-0 font-normal text-muted-foreground tabular-nums">{count}</span>
          ) : null}
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3 shrink-0", !collapsed && "rotate-90")}
          />
        </button>
        {collapsed ? null : (
          <Menu>
            <MenuTrigger render={<button type="button" aria-label="Add" className={ICON_BUTTON} />}>
              <PlusIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => openAssistantDialog()}>
                <PlusIcon />
                New assistant
              </MenuItem>
              <MenuItem onClick={() => openAssistantTeamDialog()}>
                <UsersIcon />
                New group
              </MenuItem>
              <MenuItem onClick={() => setDescribing(true)}>
                <MessageSquareTextIcon />
                Describe one and let T3 build it
              </MenuItem>
            </MenuPopup>
          </Menu>
        )}
      </li>
      {rows.map((row) => {
        if (row.kind === "folder") {
          return (
            <FolderRow
              key={row.key}
              entry={row.team}
              members={row.members}
              expanded={row.expanded}
              indicatorKind={row.indicator?.kind ?? null}
              indicatorCount={
                row.indicator !== null && "count" in row.indicator ? row.indicator.count : 0
              }
              active={
                routeTeamId === row.team.team.id && routeEnvironmentId === row.team.environmentId
              }
              onToggle={onToggleGroup}
              onOpenGroup={props.onOpenGroup}
            />
          );
        }
        if (row.kind === "more") {
          return (
            <li key={row.key} className="list-none">
              <button
                type="button"
                onClick={() =>
                  void updateClientSettings({ sidebarAssistantsShowAll: !row.showAll })
                }
                className={cn(
                  "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                  FOCUS_RING,
                )}
              >
                <ChevronDownIcon
                  aria-hidden
                  className={cn("size-3 shrink-0", row.showAll && "rotate-180")}
                />
                {row.showAll ? "Show less" : `Show all (${row.total})`}
              </button>
            </li>
          );
        }
        const chatKey =
          row.entry.assistant.threadId === null
            ? null
            : scopedThreadKey(
                scopeThreadRef(row.entry.environmentId, row.entry.assistant.threadId),
              );
        return (
          <AssistantRow
            key={row.key}
            entry={row.entry}
            mood={row.mood}
            indicatorKind={row.indicator?.kind ?? null}
            indicatorCount={
              row.indicator !== null && "count" in row.indicator ? row.indicator.count : 0
            }
            item={row.item}
            nested={row.nested}
            environmentLabel={environmentLabel(row.entry.environmentId, row.entry.assistant.id)}
            isActive={chatKey !== null && chatKey === props.routeThreadKey}
            activeThreadKey={hasTasks(row.item) ? props.routeThreadKey : null}
            onOpen={props.onOpenThread}
            jumpLabelByKey={props.jumpLabelByKey}
            renderTaskRow={hasTasks(row.item) ? props.renderTaskRow : undefined}
            onThreadContextMenu={props.onThreadContextMenu}
            reveal={revealFor(row)}
          />
        );
      })}
      <DescribeAssistantDialog open={describing} onOpenChange={setDescribing} />
    </>
  );
});
