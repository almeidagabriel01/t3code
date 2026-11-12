import {
  HEAVY_COMMAND_SOURCE_LABEL,
  heavyCommandKey,
  projectForCommand,
  readableLabel,
  peakUsageLine,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import type { EnvironmentId, HeavyCommand } from "@t3tools/contracts";
import { BotIcon, CircleStopIcon, ListOrderedIcon, TerminalIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Elapsed } from "./HeavyQueueBody";
import { GUTTER, Metrics } from "./ResourceMetrics";
import { useStopHeavyCommand } from "./useKillTarget";

const SOURCE_ICON: Record<HeavyCommand["source"], typeof BotIcon> = {
  queue: ListOrderedIcon,
  agent: BotIcon,
  terminal: TerminalIcon,
};

export interface HeavyCommandThreads {
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly projectIdOfThread: (threadId: string) => string | undefined;
  readonly onOpenThread: (threadId: string) => void;
}

function Row({
  command,
  cpuCount,
  threads,
  stop,
  scopeProjectId,
}: {
  readonly command: HeavyCommand;
  readonly cpuCount: number;
  readonly threads: HeavyCommandThreads;
  readonly stop: ReturnType<typeof useStopHeavyCommand>;
  readonly scopeProjectId: string | undefined;
}) {
  const projects = useProjects();
  const project = projectForCommand(command, projects, threads.projectIdOfThread);
  const Icon = SOURCE_ICON[command.source];
  const peak = peakUsageLine(command);
  const program = readableLabel(command.label);
  const { threadId } = command;
  const usage =
    command.cpu === undefined || command.memory === undefined
      ? null
      : { cpuPercent: (command.cpu / Math.max(1, cpuCount)) * 100, rssBytes: command.memory };
  return (
    <div className="flex items-center gap-2 py-1.5 pl-3 pr-3 hover:bg-foreground/8">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5">
        <Icon aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="cursor-default truncate text-xs font-medium text-foreground/90" />
            }
          >
            {command.name}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-sm break-all">
            {program === command.name ? command.label : program} · pid {command.pid}
          </TooltipPopup>
        </Tooltip>
        <div className="flex min-w-0 items-center gap-1 text-3xs text-muted-foreground">
          {/* A project-scoped list already names the project. */}
          {project !== undefined && project.id === scopeProjectId ? null : (
            <>
              {project === undefined ? null : (
                <ProjectFavicon project={project} className="size-3 shrink-0" />
              )}
              <span className="max-w-[40%] shrink-0 truncate">
                {project?.title ?? "No project"}
              </span>
            </>
          )}
          <span className="shrink-0 rounded-sm bg-foreground/8 px-1">
            {HEAVY_COMMAND_SOURCE_LABEL[command.source]}
          </span>
          {threadId === null ? null : (
            <button
              type="button"
              className="min-w-0 cursor-pointer truncate rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => threads.onOpenThread(threadId)}
            >
              {threads.threadTitle(threadId) ?? "Open thread"}
            </button>
          )}
          <span className="shrink-0 tabular-nums">
            <Elapsed since={command.startedAt} prefix="·" />
          </span>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger render={<div className="cursor-default" />}>
          <Metrics usage={usage} />
        </TooltipTrigger>
        <TooltipPopup side="top">{peak ?? "No peak sampled yet"}</TooltipPopup>
      </Tooltip>
      <span className={GUTTER}>
        {command.stoppable && stop.canStop ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-destructive"
                  size="icon-micro"
                  aria-label={`Stop ${command.name}`}
                  onClick={() => void stop.stop(command)}
                />
              }
            >
              <CircleStopIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="top">Stop</TooltipPopup>
          </Tooltip>
        ) : null}
      </span>
    </div>
  );
}

/** Every heavy command running now, queued or run directly by agents and terminals. */
export function HeavyCommandRows({
  environmentId,
  commands,
  cpuCount,
  threads,
  scopeProjectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly commands: ReadonlyArray<HeavyCommand>;
  readonly cpuCount: number;
  readonly threads: HeavyCommandThreads;
  readonly scopeProjectId?: string | undefined;
}) {
  const stop = useStopHeavyCommand(environmentId);
  return (
    <div>
      {commands.map((command) => (
        <Row
          key={heavyCommandKey(command)}
          command={command}
          cpuCount={cpuCount}
          threads={threads}
          stop={stop}
          scopeProjectId={scopeProjectId}
        />
      ))}
    </div>
  );
}
