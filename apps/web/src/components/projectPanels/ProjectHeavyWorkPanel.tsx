import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  heavyItemsInProject,
  heavyWork,
  heavyWorkItems,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Settings2Icon } from "lucide-react";

import { useProjects, useThreadShells } from "../../state/entities";
import { useHeavyCommands, useHeavyQueue } from "../../state/heavyQueue";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RightPanelMessage } from "../chat/RightPanelStates";
import type { HeavyCommandThreads } from "../statusBar/HeavyCommandsBody";
import { HeavyWorkList } from "../statusBar/HeavyQueueBody";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectPanelFrame } from "./ProjectPanelFrame";

/**
 * The project's heavy work, with the Resource Manager's own rows and actions: each job once, per
 * machine. The server samples processes only while this tab is visible.
 */
export function ProjectHeavyWorkPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly visible: boolean;
}) {
  const { environmentId, projectId } = props;
  const navigate = useNavigate();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const shells = new Map(
    useThreadShells()
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => [String(thread.id), thread]),
  );
  const threads: HeavyCommandThreads = {
    threadTitle: (threadId) => shells.get(threadId)?.title,
    projectIdOfThread: (threadId) => shells.get(threadId)?.projectId,
    onOpenThread: (threadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId as never)),
      }),
  };
  const { commands, cpuCount } = useHeavyCommands(props.visible ? environmentId : null);
  const queue = useHeavyQueue(environmentId);
  const match = { projectId, projects, projectIdOfThread: threads.projectIdOfThread };
  const count = heavyItemsInProject(heavyWorkItems(heavyWork(queue, commands)), match).length;
  return (
    <ProjectPanelFrame
      title="Heavy work"
      summary={count > 0 ? String(count) : null}
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Heavy work settings"
                onClick={() => void navigate({ to: "/settings/maintenance", hash: "heavy-work" })}
              />
            }
          >
            <Settings2Icon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Heavy work settings</TooltipPopup>
        </Tooltip>
      }
    >
      {count === 0 ? (
        <RightPanelMessage
          title="No heavy work in this project"
          detail="Tests, builds and other heavy commands from this project show here while they run or wait."
        />
      ) : (
        <HeavyWorkList
          environmentId={environmentId}
          projectId={projectId}
          commands={commands}
          cpuCount={cpuCount}
          threads={threads}
        />
      )}
    </ProjectPanelFrame>
  );
}
