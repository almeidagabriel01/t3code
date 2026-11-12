import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  selectProjectActivity,
  type ProjectActivityEntry,
  type ProjectActivityOutcome,
} from "@t3tools/client-runtime/state/thread-activity";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ActivityIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { useActivityEntries } from "../activity/useActivity";
import { RightPanelMessage } from "../chat/RightPanelStates";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectPanelFrame } from "./ProjectPanelFrame";

const OUTCOME: Record<
  ProjectActivityOutcome,
  { readonly label: string; readonly variant: ComponentProps<typeof Badge>["variant"] }
> = {
  "needs-you": { label: "Needs you", variant: "warning" },
  failed: { label: "Failed", variant: "error" },
  interrupted: { label: "Interrupted", variant: "secondary" },
  finished: { label: "Finished", variant: "success" },
};

/** The project's runs that wait on the user or ended unseen, newest first; a row opens its thread. */
export function ProjectActivityPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const navigate = useNavigate();
  const entries = selectProjectActivity(useActivityEntries(), props);
  const open = (entry: ProjectActivityEntry) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(entry.thread.environmentId, entry.thread.id)),
    });
  return (
    <ProjectPanelFrame
      title="Activity"
      summary={entries.length > 0 ? String(entries.length) : null}
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Open all activity"
                onClick={() => void navigate({ to: "/activity" })}
              />
            }
          >
            <ActivityIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open all activity</TooltipPopup>
        </Tooltip>
      }
    >
      {entries.length === 0 ? (
        <RightPanelMessage
          title="Nothing new in this project"
          detail="Finished, failed and waiting runs show here until you open them."
        />
      ) : (
        <ul aria-label="Project activity" className="flex flex-col">
          {entries.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                onClick={() => open(entry)}
                className="grid w-full cursor-pointer gap-0.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="truncate text-xs font-medium text-foreground/90">
                  {entry.thread.title}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
                  <Badge size="sm" variant={OUTCOME[entry.outcome].variant}>
                    {OUTCOME[entry.outcome].label}
                  </Badge>
                  {entry.at === null ? null : (
                    <span className="truncate tabular-nums">
                      <RelativeTime timestamp={entry.at} />
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </ProjectPanelFrame>
  );
}
