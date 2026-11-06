import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ChevronRightIcon,
  UserRoundIcon,
  UsersIcon,
  EllipsisIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { type AssistantEntry, useAssistantEntries } from "../../state/assistants";
import { useThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarNotificationDotClass, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { resolveSidebarThreadStatus } from "@t3tools/client-runtime/state/thread-attention";
import { SidebarNotificationDot } from "../sidebar/SidebarNotificationDot";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AssistantAvatar } from "./assistantPresentation";
import { openAssistantDialog } from "./assistantDialogState";
import { openAssistantTeamActivity } from "./assistantTeamState";
import { useAssistantFlows } from "./useAssistantFlows";

/** What a row and a collapsed avatar both show: working, the attention dot, and how to open. */
function useAssistantState(entry: AssistantEntry, onOpen: (threadRef: ScopedThreadRef) => void) {
  const { assistant, environmentId } = entry;
  const threadRef =
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId);
  const thread = useThreadShell(threadRef);
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const localLastVisitedAt = useUiStateStore((state) =>
    threadKey === null ? undefined : state.threadLastVisitedAtById[threadKey],
  );
  const working = thread !== null && resolveSidebarThreadStatus(thread) === "working";
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
  return { working, dotClass, open };
}

const AssistantRow = memo(function AssistantRow(props: {
  readonly entry: AssistantEntry;
  readonly environmentLabel: string | null;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const { working, dotClass, open } = useAssistantState(props.entry, props.onOpen);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={`assistant:${environmentId}:${assistant.id}`}
        aria-label={`${assistant.name}${working ? ", working" : ""}`}
        aria-current={props.isActive ? "page" : undefined}
        data-testid="sidebar-assistant-row"
        className={cn(
          "group/sidebar-row flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sm font-medium text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive && "bg-sidebar-row-active",
        )}
        onClick={open}
        onKeyDown={onKeyDown}
      >
        <AssistantAvatar assistant={assistant} />
        <span className="min-w-0 flex-1 truncate">{assistant.name}</span>
        {props.environmentLabel ? (
          <Badge variant="outline" size="sm">
            <span className="max-w-24 truncate">{props.environmentLabel}</span>
          </Badge>
        ) : null}
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
  const { working, dotClass, open } = useAssistantState(props.entry, props.onOpen);
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
        <AssistantAvatar assistant={assistant} />
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

/** Pinned above the project groups: one row per active assistant, and a way to add another. */
export const AssistantSidebarSection = memo(function AssistantSidebarSection(props: {
  readonly routeThreadKey: string | null;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { active, teams } = useAssistantEntries();
  const enabled = useClientSettings((settings) => settings.sidebarShowAssistantsSection);
  const collapsed = useClientSettings((settings) => settings.sidebarAssistantsCollapsed);
  if (!enabled || active.length === 0) return null;
  const environmentCount = new Set(active.map((entry) => entry.environmentId)).size;
  const keyOf = (entry: AssistantEntry) =>
    entry.assistant.threadId
      ? scopedThreadKey(scopeThreadRef(entry.environmentId, entry.assistant.threadId))
      : null;
  const strip = active.slice(0, COLLAPSED_AVATARS);
  const overflow = active.length - strip.length;
  const toggle = () => void updateClientSettings({ sidebarAssistantsCollapsed: !collapsed });
  return (
    <>
      <li
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={`Assistants, ${active.length}`}
        data-sidebar-row="section:assistants"
        className="flex h-7 cursor-pointer list-none items-center gap-1 rounded-md px-(--sidebar-row-content-inset) outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
              className="inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md px-1 text-2xs text-muted-foreground tabular-nums outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              +{overflow}
            </button>
          ) : null}
        </span>
        {collapsed ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New assistant"
                  onClick={() => openAssistantDialog()}
                  className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              <PlusIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="top">New assistant</TooltipPopup>
          </Tooltip>
        )}
        <button
          type="button"
          aria-label={collapsed ? "Expand assistants" : "Collapse assistants"}
          aria-expanded={!collapsed}
          onClick={toggle}
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0", !collapsed && "rotate-90")}
          />
        </button>
      </li>
      {collapsed
        ? null
        : active.map((entry) => {
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
              />
            );
          })}
      {collapsed
        ? null
        : teams.map(({ environmentId, team }) => (
            <li key={`${environmentId}:${team.id}`} className="list-none py-0.5">
              <button
                type="button"
                data-testid="sidebar-team-row"
                aria-label={`${team.name} team, ${team.memberIds.length} members`}
                onClick={() => openAssistantTeamActivity(environmentId, team.id)}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sm font-medium text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <UsersIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                <span className="min-w-0 flex-1 truncate">{team.name}</span>
                <span className="text-2xs text-muted-foreground tabular-nums">
                  {team.memberIds.length}
                </span>
              </button>
            </li>
          ))}
      <li
        aria-hidden
        data-testid="sidebar-assistants-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});
