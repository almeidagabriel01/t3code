import {
  HEAVY_COMMAND_SOURCE_LABEL,
  heavyCommandKey,
  projectForCommand,
  readableLabel,
  runningUsageLine,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import type { EnvironmentId, HeavyCommand } from "@t3tools/contracts";
import { BotIcon, ListOrderedIcon, SquareIcon, TerminalIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Elapsed } from "./HeavyQueueBody";
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
}: {
  readonly command: HeavyCommand;
  readonly cpuCount: number;
  readonly threads: HeavyCommandThreads;
  readonly stop: ReturnType<typeof useStopHeavyCommand>;
}) {
  const projects = useProjects();
  const project = projectForCommand(command, projects, threads.projectIdOfThread);
  const Icon = SOURCE_ICON[command.source];
  const usage = runningUsageLine(command, cpuCount);
  const program = readableLabel(command.label);
  const { threadId } = command;
  return (
    <div className="flex items-center gap-1.5 py-1.5 pl-2 pr-3 hover:bg-foreground/8">
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3">
        <Icon aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-3xs text-muted-foreground">
          {project === undefined ? null : (
            <ProjectFavicon project={project} className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{project?.title ?? "No project"}</span>
          <span className="shrink-0 rounded-sm bg-foreground/8 px-1">
            {HEAVY_COMMAND_SOURCE_LABEL[command.source]}
          </span>
        </div>
        <div className="truncate text-xs font-medium text-foreground/90">{command.name}</div>
        {program === command.name ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <div className="cursor-default truncate font-mono text-3xs text-muted-foreground" />
              }
            >
              {program}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-sm break-all">
              {command.label} · pid {command.pid}
            </TooltipPopup>
          </Tooltip>
        )}
        {usage === null ? null : (
          <div className="truncate text-3xs text-muted-foreground">{usage}</div>
        )}
        {threadId === null ? null : (
          <button
            type="button"
            className="block max-w-full cursor-pointer truncate rounded-sm text-3xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => threads.onOpenThread(threadId)}
          >
            {threads.threadTitle(threadId) ?? "Open thread"}
          </button>
        )}
      </div>
      <span className="shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
        <Elapsed since={command.startedAt} prefix="Running ·" />
      </span>
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
            <SquareIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top">Stop</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** Every heavy command running now, queued or run directly by agents and terminals. */
export function HeavyCommandRows({
  environmentId,
  commands,
  cpuCount,
  threads,
}: {
  readonly environmentId: EnvironmentId;
  readonly commands: ReadonlyArray<HeavyCommand>;
  readonly cpuCount: number;
  readonly threads: HeavyCommandThreads;
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
        />
      ))}
    </div>
  );
}
