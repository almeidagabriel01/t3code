import {
  localDayStarts,
  scheduledTaskAgenda,
  sortScheduledTasks,
} from "@t3tools/client-runtime/scheduledTaskAgenda";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScheduledTask } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  EllipsisIcon,
  MessageSquareIcon,
  PanelRightOpenIcon,
  PauseIcon,
  PlayIcon,
  Settings2Icon,
  ZapIcon,
} from "lucide-react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { RightPanelLoading, RightPanelMessage } from "../chat/RightPanelStates";
import { STATUS_DOT_CLASS, taskScheduleLine } from "../chat/ThreadAutomationsPanel";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ScheduledTasksAgenda } from "./ScheduledTasksAgenda";
import { useScheduledTaskCommands } from "./useScheduledTaskCommands";

export interface ScheduledTasksSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** The project's scheduled tasks: a two-day agenda of upcoming runs, then the task list. */
export function ScheduledTasksSurface({ environmentId, projectId }: ScheduledTasksSurfaceProps) {
  const navigate = useNavigate();
  const now = useNowMinuteMs();
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const commands = useScheduledTaskCommands(environmentId, "panel scheduled task");
  const tasks = sortScheduledTasks(
    (query.data?.tasks ?? []).filter((task) => task.projectId === projectId),
  );
  const days = scheduledTaskAgenda(tasks, now, localDayStarts(now, 2));

  const openTask = (task: ScheduledTask) =>
    void navigate({ to: "/settings/scheduled-tasks", search: { environmentId, taskId: task.id } });
  const openThread = (task: ScheduledTask) => {
    if (task.threadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: scopeThreadRef(environmentId, task.threadId),
    });
  };

  const header = (
    <div
      className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2"
      data-glass-layer
    >
      <h2 className="min-w-0 truncate text-sm font-medium">Scheduled tasks</h2>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Manage scheduled tasks"
              className="ms-auto"
              onClick={() =>
                void navigate({ to: "/settings/scheduled-tasks", search: { environmentId } })
              }
            />
          }
        >
          <Settings2Icon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Manage scheduled tasks</TooltipPopup>
      </Tooltip>
    </div>
  );

  if (query.error !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <RightPanelMessage title="Could not load scheduled tasks" detail={query.error} alert />
      </div>
    );
  }
  if (query.data === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <RightPanelLoading label="Loading scheduled tasks…" />
      </div>
    );
  }

  return (
    <div className="@container/scheduled-panel flex h-full min-h-0 flex-col">
      {header}
      <div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-foreground/10 px-2 py-2 @md/scheduled-panel:px-3">
        <ScheduledTasksAgenda days={days} onOpenTask={openTask} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2 @md/scheduled-panel:px-2">
        <h3 className="flex h-7 items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
          Tasks
          <span className="text-2xs tabular-nums">{tasks.length}</span>
        </h3>
        {tasks.length === 0 ? (
          <RightPanelMessage
            title="No scheduled tasks in this project"
            detail="Create one in Settings, or ask the agent to schedule a task."
          />
        ) : (
          <ul className="flex flex-col">
            {tasks.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                task={task}
                canOperate={commands.canOperate}
                busy={commands.busyTaskId !== null}
                onOpen={() => openTask(task)}
                onOpenThread={task.threadId === null ? null : () => openThread(task)}
                onRunNow={() => void commands.runNow(task)}
                onSetEnabled={(enabled) => void commands.setEnabled(task, enabled)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ScheduledTaskRow(props: {
  readonly task: ScheduledTask;
  readonly canOperate: boolean;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onOpenThread: (() => void) | null;
  readonly onRunNow: () => void;
  readonly onSetEnabled: (enabled: boolean) => void;
}) {
  const { task } = props;
  const disabled = !props.canOperate || props.busy;
  const pauseLabel = task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`;
  return (
    <li className="flex items-start gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/6 has-focus-visible:bg-foreground/6">
      <button
        type="button"
        onClick={props.onOpen}
        className="grid min-w-0 flex-1 cursor-pointer gap-0.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[task.lastRunStatus])}
          />
          <span
            className={cn(
              "truncate text-sm font-medium",
              task.enabled ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {task.title}
          </span>
        </span>
        <span className="truncate ps-3.5 text-xs text-muted-foreground">
          {taskScheduleLine(task)}
        </span>
      </button>
      {/* Webhook tasks need a request from their URL. */}
      {task.schedule.type === "webhook" ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Run ${task.title} now`}
                disabled={disabled || task.lastRunStatus === "running"}
                onClick={props.onRunNow}
              />
            }
          >
            <ZapIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>Run now</TooltipPopup>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={pauseLabel}
              disabled={disabled}
              onClick={() => props.onSetEnabled(!task.enabled)}
            />
          }
        >
          {task.enabled ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
        </TooltipTrigger>
        <TooltipPopup>{task.enabled ? "Pause" : "Resume"}</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button size="icon-xs" variant="ghost-muted" aria-label={`Actions for ${task.title}`} />
          }
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={props.onOpen}>
            <PanelRightOpenIcon aria-hidden />
            Open task
          </MenuItem>
          {props.onOpenThread ? (
            <MenuItem onClick={props.onOpenThread}>
              <MessageSquareIcon aria-hidden />
              Open thread
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </li>
  );
}
