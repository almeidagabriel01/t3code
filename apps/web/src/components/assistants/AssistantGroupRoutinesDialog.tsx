import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PauseIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  assistantGroupRoutinesAtom,
  type AssistantGroupSettingsTarget,
} from "./assistantTeamState";

export function AssistantGroupRoutinesHost() {
  const target = useAtomValue(assistantGroupRoutinesAtom);
  if (target === null) return null;
  return (
    <AssistantGroupRoutinesDialog
      key={`${target.environmentId}:${target.teamId}`}
      target={target}
      onClose={() => appAtomRegistry.set(assistantGroupRoutinesAtom, null)}
    />
  );
}

function RoutineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onEdit: () => void;
}) {
  const { environmentId, task } = props;
  const settings = useEnvironmentSettings(environmentId);
  const [busy, setBusy] = useState(false);
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "group routine enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "group routine run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "group routine delete",
  });
  const canOperate = readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const act = async (action: "toggle" | "run" | "delete") => {
    if (busy || !canOperate) return;
    if (action === "delete") {
      const confirmed = await requestConfirmDialog(`Delete the routine ${task.title}?`, {
        variant: "destructive",
      });
      if (confirmed === false) return;
    }
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : action === "run"
          ? await run({ environmentId, input: { id: task.id } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update the routine",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  const limitReached = task.maxRuns != null && task.runCount >= task.maxRuns;
  const next = !task.enabled
    ? limitReached
      ? "Stopped at its run limit"
      : "Paused"
    : task.nextRunAt
      ? `Next run ${formatUpcomingTimestamp(task.nextRunAt, settings.timestampFormat)}`
      : "Not scheduled";
  return (
    <li className="flex flex-col gap-2 py-3" data-testid="group-routine">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span>
        {task.lastRunStatus === "failed" ? (
          <Badge variant="error">failed</Badge>
        ) : task.lastRunStatus === "succeeded" ? (
          <Badge variant="success">posted</Badge>
        ) : null}
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>
      <p className="text-xs text-muted-foreground">
        {scheduleLabel(task.schedule)} · {next}
        {task.maxRuns == null ? "" : ` · ${task.runCount} of ${task.maxRuns} runs`}
        {task.schedule.type === "fixed_time" && task.missedRunPolicy === "once"
          ? " · catches up once if missed"
          : ""}
      </p>
      {task.lastRunError ? <p className="text-xs text-destructive">{task.lastRunError}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !canOperate}
          onClick={() => void act("run")}
        >
          <PlayIcon />
          Run now
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !canOperate}
          onClick={() => void act("toggle")}
        >
          {task.enabled ? <PauseIcon /> : <PlayIcon />}
          {task.enabled ? "Pause" : "Resume"}
        </Button>
        <Button size="xs" variant="outline" disabled={!canOperate} onClick={props.onEdit}>
          <PencilIcon />
          Edit
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Delete ${task.title}`}
                disabled={busy || !canOperate}
                onClick={() => void act("delete")}
              />
            }
          >
            <Trash2Icon />
          </TooltipTrigger>
          <TooltipPopup>Delete</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
}

function AssistantGroupRoutinesDialog(props: {
  readonly target: AssistantGroupSettingsTarget;
  readonly onClose: () => void;
}) {
  const { environmentId, teamId } = props.target;
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const routines = query.data?.tasks.filter((task) => task.assistantTeamId === teamId);
  const open = (
    search: { readonly taskId: ScheduledTask["id"] } | { readonly assistantTeamId: string },
  ) => {
    props.onClose();
    void navigate({
      to: "/settings/scheduled-tasks",
      search: { environmentId, ...search },
    });
  };
  return (
    <Dialog open onOpenChange={(next) => !next && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Group routines</DialogTitle>
          <DialogDescription>
            Each run posts its request in the group chat, as if you had written it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {query.error ? (
            <p className="text-sm text-destructive">{query.error}</p>
          ) : routines === undefined ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading routines…
            </p>
          ) : routines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No routines in this group yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-foreground/12">
              {routines.map((task) => (
                <RoutineRow
                  key={task.id}
                  environmentId={environmentId}
                  task={task}
                  onEdit={() => open({ taskId: task.id })}
                />
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
          <Button onClick={() => open({ assistantTeamId: teamId })}>
            <PlusIcon />
            New routine
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
