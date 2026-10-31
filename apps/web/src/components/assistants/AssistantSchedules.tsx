import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { taskScheduleLine } from "../chat/ThreadAutomationsPanel";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The scheduled tasks bound to the assistant's current conversation. */
export function AssistantSchedules(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(props.environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "assistant schedule toggle",
  });
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const tasks = (tasksQuery.data?.tasks ?? []).filter((task) => task.threadId === props.threadId);

  const open = (search: { taskId?: ScheduledTask["id"]; threadId?: ThreadId }) => {
    props.onNavigate();
    void navigate({
      to: "/settings/scheduled-tasks",
      search: { environmentId: props.environmentId, ...search },
    });
  };
  const toggle = async (task: ScheduledTask, enabled: boolean) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update schedule",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Schedules</span>
          <p className="text-xs text-muted-foreground">
            Prompts that run in this conversation on a timer or a webhook.
          </p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => open({ threadId: props.threadId })}
        >
          <PlusIcon />
          New schedule
        </Button>
      </div>
      {tasksQuery.error !== null ? (
        <p className="text-xs text-destructive-foreground">
          Could not load schedules: {tasksQuery.error}
        </p>
      ) : tasks.length === 0 ? (
        <p className="rounded-md px-2 py-1.5 text-xs text-muted-foreground">
          Nothing scheduled. Add a schedule to have it check in on its own.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <CalendarClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{task.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {taskScheduleLine(task)}
                </span>
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Edit ${task.title}`}
                onClick={() => open({ taskId: task.id })}
              >
                <PencilIcon />
              </Button>
              <Switch
                checked={task.enabled}
                disabled={!canOperate || busyTaskId !== null}
                aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
                onCheckedChange={(enabled) => void toggle(task, enabled)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
