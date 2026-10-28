import { Link } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useRunningGroups } from "../../state/running";
import { buildThreadRouteParams } from "../../threadRoutes";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import type { RunningProjectGroup, RunningThreadState } from "./running.logic";

const STATE_LABEL: Record<RunningThreadState, string> = {
  running: "Working",
  attention: "Needs you",
};

const STATE_DOT: Record<RunningThreadState, string> = {
  running: "bg-sky-500 dark:bg-sky-300/80",
  attention: "bg-amber-500 dark:bg-amber-300/90",
};

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

function groupWork(group: RunningProjectGroup): string {
  return [
    group.running > 0 ? `${group.running} working` : null,
    group.attention > 0 ? `${group.attention} need you` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Every thread that is working or waiting on the user, grouped by project. */
export function RunningPage() {
  const groups = useRunningGroups();
  const running = groups.reduce((sum, group) => sum + group.running, 0);
  const attention = groups.reduce((sum, group) => sum + group.attention, 0);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Running</h1>
      </WorkspacePageHeader>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide">
          <p className="text-sm text-muted-foreground" role="status">
            {running + attention === 0
              ? "Nothing running."
              : `${plural(running, "thread")} working, ${attention} need you.`}
          </p>
          {groups.map((group) => (
            <section key={group.key} aria-label={group.title} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2 px-2">
                <h2 className="truncate text-sm font-medium">{group.title}</h2>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                  {groupWork(group)}
                </span>
              </div>
              <ul className="flex flex-col">
                {group.threads.map((thread) => (
                  <li key={thread.key}>
                    <Link
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams(thread.ref)}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span
                        aria-hidden
                        className={cn("size-2 shrink-0 rounded-full", STATE_DOT[thread.state])}
                      />
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {STATE_LABEL[thread.state]}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </WorkspacePageContainer>
      </main>
    </SidebarInset>
  );
}
