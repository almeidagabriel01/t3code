import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ArrowLeftIcon, BellIcon, EllipsisIcon, ExternalLinkIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useDelegatedUnderParent, useProjects, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { type SidebarPriorityHolds } from "../Sidebar.logic";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { RelativeTime } from "../RelativeTime";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { buildActivityEntries, type ActivityEntry, type ActivityRank } from "./activity.logic";
import { useActivityRead } from "./useActivityRead";

// ChatView reaches this page through the route tree, so load it lazily as the side chat does.
const ChatView = lazy(() => import("../ChatView"));

const RANKS: readonly { rank: ActivityRank; heading: string; summary: string; dot: string }[] = [
  { rank: 0, heading: "Needs you", summary: "need you", dot: "bg-amber-500 dark:bg-amber-300/90" },
  { rank: 1, heading: "Working", summary: "working", dot: "bg-sky-500 dark:bg-sky-300/80" },
  { rank: 2, heading: "Unread", summary: "unread", dot: "bg-emerald-500 dark:bg-emerald-300/80" },
];

function sameHolds(left: SidebarPriorityHolds, right: SidebarPriorityHolds): boolean {
  if (left.size !== right.size) return false;
  for (const [key, settledOverride] of left) {
    if (!right.has(key) || right.get(key) !== settledOverride) return false;
  }
  return true;
}

function ActivityRow(props: {
  readonly entry: ActivityEntry;
  readonly projectTitle: string;
  readonly selected: boolean;
  readonly dot: string;
  readonly onSelect: () => void;
}) {
  const { entry } = props;
  return (
    <li>
      <button
        type="button"
        aria-current={props.selected ? "true" : undefined}
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.selected && "bg-accent",
        )}
        onClick={props.onSelect}
      >
        <span className="flex items-center gap-2 text-sm">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", props.dot)} />
          <span className="min-w-0 flex-1 truncate">{entry.thread.title}</span>
        </span>
        <span className="flex items-center gap-1 pl-4 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{props.projectTitle}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">
            <RelativeTime timestamp={entry.thread.updatedAt} />
          </span>
        </span>
      </button>
    </li>
  );
}

/** Threads that need the user, are working, or finished unseen; the selected one opens beside the list. */
export function ActivityPage() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const threads = useThreadShells();
  const projects = useProjects();
  const delegatedUnderParent = useDelegatedUnderParent();
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const now = useNowMinute();
  const [holds, setHolds] = useState<SidebarPriorityHolds>(() => new Map());
  const [releases, setReleases] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const entries = buildActivityEntries({
    threads,
    delegatedUnderParent,
    localLastVisitedAtByKey,
    holds,
    releases,
    now,
  });
  const nextHolds: SidebarPriorityHolds = new Map(
    entries.map((entry) => [entry.key, entry.thread.settledOverride]),
  );
  if (!sameHolds(nextHolds, holds)) {
    setHolds(nextHolds);
    setReleases((current) =>
      [...current].every((key) => nextHolds.has(key))
        ? current
        : new Set([...current].filter((key) => nextHolds.has(key))),
    );
  }

  const read = useActivityRead({
    threads: entries.map((entry) => entry.thread),
    snoozeNow: now,
    releaseThreads: (keys) => setReleases((current) => new Set([...current, ...keys])),
    restoreThread: (key) =>
      setReleases((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      }),
  });

  const projectTitle = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const selected = entries.find((entry) => entry.key === selectedKey) ?? null;
  const summary = RANKS.map(({ rank, summary: label }) => {
    const count = entries.filter((entry) => entry.rank === rank).length;
    return count > 0 ? `${count} ${label}` : null;
  })
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close activity"
                onClick={() => void navigateToMainApp()}
              />
            }
          >
            <ArrowLeftIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Close</TooltipPopup>
        </Tooltip>
        <BellIcon aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Activity</h1>
        <span className="text-xs text-muted-foreground tabular-nums" role="status">
          {summary}
        </span>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="Activity actions"
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            <MenuItem disabled={!read.canMarkAllRead} onClick={read.markAllRead}>
              Mark all as read
            </MenuItem>
            <MenuItem disabled={!read.canClearRead} onClick={read.clearRead}>
              Clear read
            </MenuItem>
          </MenuPopup>
        </Menu>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1 border-t border-border">
        <nav
          aria-label="Activity threads"
          className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-2"
        >
          {entries.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground" role="status">
              Nothing needs you right now.
            </p>
          ) : (
            RANKS.map(({ rank, heading, dot }) => {
              const group = entries.filter((entry) => entry.rank === rank);
              return group.length === 0 ? null : (
                <section key={rank} aria-label={heading} className="flex flex-col gap-1">
                  <h2 className="px-2 text-xs font-medium text-muted-foreground">
                    {heading} ({group.length})
                  </h2>
                  <ul className="flex flex-col">
                    {group.map((entry) => (
                      <ActivityRow
                        key={entry.key}
                        entry={entry}
                        projectTitle={
                          projectTitle.get(
                            `${entry.thread.environmentId}:${entry.thread.projectId}`,
                          ) ?? "Unknown project"
                        }
                        selected={entry.key === selected?.key}
                        dot={dot}
                        onSelect={() => setSelectedKey(entry.key)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })
          )}
        </nav>
        <section aria-label="Selected thread" className="flex min-w-0 flex-1 flex-col">
          {selected === null ? (
            <p className="m-auto text-sm text-muted-foreground">Select a thread to read it here.</p>
          ) : (
            <>
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {selected.thread.title}
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Open as a full thread"
                        onClick={() =>
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: buildThreadRouteParams(
                              scopeThreadRef(selected.thread.environmentId, selected.thread.id),
                            ),
                          })
                        }
                      />
                    }
                  >
                    <ExternalLinkIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Open as a full thread</TooltipPopup>
                </Tooltip>
              </div>
              <div className="relative flex min-h-0 flex-1">
                <Suspense fallback={null}>
                  <BackgroundThreadContext value>
                    <ChatView
                      key={selected.key}
                      environmentId={selected.thread.environmentId}
                      threadId={selected.thread.id}
                      routeKind="server"
                      reserveTitleBarControlInset={false}
                      embedded
                    />
                  </BackgroundThreadContext>
                </Suspense>
              </div>
            </>
          )}
        </section>
      </div>
    </SidebarInset>
  );
}
