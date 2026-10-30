import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ArchiveIcon,
  UserRoundIcon,
  EllipsisIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "~/lib/utils";
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
import { useAssistantFlows } from "./useAssistantFlows";

const AssistantRow = memo(function AssistantRow(props: {
  readonly entry: AssistantEntry;
  readonly environmentLabel: string | null;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
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
    if (threadRef !== null) props.onOpen(threadRef);
  };
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
        role="treeitem"
        tabIndex={-1}
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
            {assistant.isDefault ? null : (
              <>
                <MenuSeparator />
                <MenuItem disabled={!flows.canAct} onClick={() => void flows.archive(assistant)}>
                  <ArchiveIcon />
                  Archive assistant
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
});

/** Pinned above the project groups: one row per active assistant, and a way to add another. */
export const AssistantSidebarSection = memo(function AssistantSidebarSection(props: {
  readonly routeThreadKey: string | null;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { active } = useAssistantEntries();
  if (active.length === 0) return null;
  const environmentCount = new Set(active.map((entry) => entry.environmentId)).size;
  return (
    <>
      <li
        role="presentation"
        className="flex h-7 list-none items-center gap-1 px-(--sidebar-row-content-inset)"
      >
        <UserRoundIcon aria-hidden className="size-3.5 shrink-0 text-(--sidebar-icon-color)" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
          Assistants
        </span>
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
      </li>
      {active.map((entry) => {
        const key = entry.assistant.threadId
          ? scopedThreadKey(scopeThreadRef(entry.environmentId, entry.assistant.threadId))
          : null;
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
      <li
        aria-hidden
        data-testid="sidebar-assistants-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});
