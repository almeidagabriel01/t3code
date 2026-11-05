import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectAgentsSection } from "@t3tools/client-runtime/state/thread-activity";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, CheckIcon, ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { memo } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { useActivityEntries } from "../activity/useActivity";
import { ProjectFavicon } from "../ProjectFavicon";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const VISIBLE_ROWS = 6;

const rowClass =
  "group/sidebar-row flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function AgentRow(props: {
  readonly entry: ReturnType<typeof selectAgentsSection>["working"][number];
  readonly project: Parameters<typeof ProjectFavicon>[0]["project"] | undefined;
  readonly nowMs: number;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { thread, at } = props.entry;
  const needsYou = props.entry.rank === 0;
  const working = props.entry.rank === 1;
  const projectName = props.project?.title ?? "Unknown project";
  const state = needsYou
    ? "Needs you"
    : working
      ? at === null
        ? "Working"
        : `Working ${formatElapsedDurationLabel(at, props.nowMs)}`
      : "Finished";
  return (
    <li className="list-none py-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-testid="sidebar-agent-row"
              aria-label={`${thread.title}, ${projectName}, ${state}`}
              aria-current={props.isActive ? "page" : undefined}
              className={cn(rowClass, props.isActive && "bg-sidebar-row-active")}
              onClick={() => props.onOpen(scopeThreadRef(thread.environmentId, thread.id))}
            />
          }
        >
          {props.project ? (
            <ProjectFavicon project={props.project} className="size-4 shrink-0" />
          ) : (
            <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{thread.title}</span>
          {needsYou ? (
            <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
          ) : working ? (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <Spinner size="xs" tone="muted" aria-hidden />
              {at === null ? null : formatElapsedDurationLabel(at, props.nowMs)}
            </span>
          ) : (
            <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {thread.title} · {projectName}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

/** Pinned below the Assistants: threads that need the user, work, or finished unseen. */
export const AgentsSidebarSection = memo(function AgentsSidebarSection(props: {
  readonly routeThreadKey: string | null;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const enabled = useClientSettings((settings) => settings.sidebarShowAgentsSection);
  const collapsed = useClientSettings((settings) => settings.sidebarAgentsCollapsed);
  const doneCollapsed = useClientSettings((settings) => settings.sidebarAgentsDoneCollapsed);
  const entries = useActivityEntries();
  const projects = useProjects();
  const nowMs = useNowMinuteMs();
  const navigate = useNavigate();
  const { needsYou, working, done } = selectAgentsSection(entries);
  const total = needsYou.length + working.length + done.length;
  if (!enabled || total === 0) return null;
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const groups = [
    { id: "needs-you" as const, heading: "Needs you", items: needsYou },
    { id: "working" as const, heading: "Working", items: working },
    { id: "done" as const, heading: "Done", items: done },
  ].filter((group) => group.items.length > 0);
  return (
    <>
      <li role="presentation" className="list-none">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`Agents, ${total}`}
          onClick={() => void updateClientSettings({ sidebarAgentsCollapsed: !collapsed })}
          className="flex h-7 w-full cursor-pointer items-center gap-1 rounded-md px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <BotIcon aria-hidden className="size-3.5 shrink-0 text-(--sidebar-icon-color)" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
            Agents
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{total}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 text-muted-foreground", !collapsed && "rotate-90")}
          />
        </button>
      </li>
      {collapsed
        ? null
        : groups.map((group) => {
            const hidden = group.id === "done" && doneCollapsed;
            const shown = hidden ? [] : group.items.slice(0, VISIBLE_ROWS);
            return (
              <li key={group.id} role="presentation" className="list-none">
                {group.id === "done" ? (
                  <button
                    type="button"
                    aria-expanded={!doneCollapsed}
                    onClick={() =>
                      void updateClientSettings({ sidebarAgentsDoneCollapsed: !doneCollapsed })
                    }
                    className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-md px-(--sidebar-row-content-inset) text-left text-2xs text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {group.heading} · {group.items.length}
                    </span>
                    <ChevronRightIcon
                      aria-hidden
                      className={cn("size-3 shrink-0", !doneCollapsed && "rotate-90")}
                    />
                  </button>
                ) : (
                  <p className="px-(--sidebar-row-content-inset) pt-1 text-2xs text-muted-foreground">
                    {group.heading} · {group.items.length}
                  </p>
                )}
                <ul>
                  {shown.map((entry) => (
                    <AgentRow
                      key={entry.key}
                      entry={entry}
                      project={projectByKey.get(
                        `${entry.thread.environmentId}:${entry.thread.projectId}`,
                      )}
                      nowMs={nowMs}
                      isActive={entry.key === props.routeThreadKey}
                      onOpen={props.onOpenThread}
                    />
                  ))}
                </ul>
                {!hidden && group.items.length > VISIBLE_ROWS ? (
                  <button
                    type="button"
                    onClick={() => void navigate({ to: "/activity" })}
                    className="mx-(--sidebar-row-content-inset) mb-1 cursor-pointer rounded-md px-1 text-xs text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    Show all {group.items.length}
                  </button>
                ) : null}
              </li>
            );
          })}
      <li
        aria-hidden
        data-testid="sidebar-agents-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});
