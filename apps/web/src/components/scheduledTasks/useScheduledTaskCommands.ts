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
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** Pause, resume and run-now for scheduled tasks, one at a time, with failures as toasts. */
export function useScheduledTaskCommands(environmentId: EnvironmentId, label: string) {
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: `${label} toggle`,
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: `${label} run now`,
  });
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const ready = () =>
    busyTaskId === null && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

  const setEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (!ready()) return;
    setBusyTaskId(task.id);
    const result = await setTaskEnabled({ environmentId, input: { id: task.id, enabled } });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(
        enabled ? "Could not resume the task" : "Could not pause the task",
        squashAtomCommandFailure(result),
      );
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (!ready()) return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({ environmentId, input: { id: task.id } });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not run the task", squashAtomCommandFailure(result));
    }
  };

  return { canOperate, busyTaskId, setEnabled, runNow };
}
