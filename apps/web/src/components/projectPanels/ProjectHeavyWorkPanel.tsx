import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { heavyItemsInProject } from "@t3tools/client-runtime/state/heavyQueueModel";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Settings2Icon } from "lucide-react";

import { useProjects, useThreadShells } from "../../state/entities";
import { useHeavyCommands, useHeavyQueue } from "../../state/heavyQueue";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RightPanelMessage } from "../chat/RightPanelStates";
import { HeavyCommandRows, type HeavyCommandThreads } from "../statusBar/HeavyCommandsBody";
import { HeavyQueueBody } from "../statusBar/HeavyQueueBody";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectPanelFrame } from "./ProjectPanelFrame";

function Section(props: {
  readonly title: string;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <section aria-label={props.title} className="pb-2">
      <h3 className="flex h-7 items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
        {props.title}
        <span className="text-2xs tabular-nums">{props.count}</span>
      </h3>
      {props.children}
    </section>
  );
}

/**
 * The project's heavy commands and queue entries, with the Resource Manager's own rows and
 * actions. The server samples processes only while this tab is visible.
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
  const running = heavyItemsInProject(commands, match);
  const queued = heavyItemsInProject(queue.entries, match);
  return (
    <ProjectPanelFrame
      title="Heavy work"
      summary={running.length + queued.length > 0 ? String(running.length + queued.length) : null}
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
      {running.length === 0 && queued.length === 0 ? (
        <RightPanelMessage
          title="No heavy work in this project"
          detail="Tests, builds and other heavy commands from this project show here while they run or wait."
        />
      ) : (
        <>
          {running.length === 0 ? null : (
            <Section title="Running now" count={running.length}>
              <HeavyCommandRows
                environmentId={environmentId}
                commands={running}
                cpuCount={cpuCount}
                threads={threads}
                scopeProjectId={projectId}
              />
            </Section>
          )}
          {queued.length === 0 ? null : (
            <Section title="Queue" count={queued.length}>
              <HeavyQueueBody
                environmentId={environmentId}
                projectId={projectId}
                threadTitle={threads.threadTitle}
                projectIdOfThread={threads.projectIdOfThread}
                onOpenThread={threads.onOpenThread}
              />
            </Section>
          )}
        </>
      )}
    </ProjectPanelFrame>
  );
}
