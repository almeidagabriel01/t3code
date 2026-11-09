import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  type DeviceShutdownInput,
  type EnvironmentId,
  type ListeningPort,
  type TerminalCloseInput,
} from "@t3tools/contracts";

import { ensureLocalApi } from "../../localApi";
import { deviceEnvironment } from "../../state/device";
import { heavyQueueEnvironment } from "../../state/heavyQueue";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

const confirmKill = (message: string) =>
  ensureLocalApi().dialogs.confirm(message, { variant: "destructive" });

/** Kills straight away, as Orca does: a port is cheap to restart and the row's trash icon is the intent. */
export function useKillListeningPort(environmentId: EnvironmentId | null) {
  const canKill = useAtomValue(serverEnvironment.killListeningPort.permissionAtom(environmentId));
  const command = useAtomCommand(serverEnvironment.killListeningPort, { reportFailure: false });
  const kill = async (port: ListeningPort) => {
    if (environmentId === null || port.pid === null) return;
    const result = await command({ environmentId, input: { pid: port.pid, port: port.port } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not stop process", squashAtomCommandFailure(result));
      }
      return;
    }
    toastManager.add({ type: "success", title: `Stopped process on ${port.port}` });
  };
  return { canKill, kill };
}

export function useCloseTerminal(environmentId: EnvironmentId) {
  const canClose = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const command = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const close = async (input: TerminalCloseInput, label: string) => {
    if (!(await confirmKill(`Close terminal "${label}" and stop its processes?`))) return;
    const result = await command({ environmentId, input });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not close terminal", squashAtomCommandFailure(result));
    }
  };
  return { canClose, close };
}

export function useShutDownDevice(environmentId: EnvironmentId) {
  const canShutDown = useAtomValue(deviceEnvironment.shutdown.permissionAtom(environmentId));
  const command = useAtomCommand(deviceEnvironment.shutdown, { reportFailure: false });
  const shutDown = async (targets: ReadonlyArray<DeviceShutdownInput>, label: string) => {
    if (!(await confirmKill(`Shut down ${label}? Apps running on it stop.`))) return;
    for (const input of targets) {
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Could not shut down device", squashAtomCommandFailure(result));
        }
        return;
      }
    }
  };
  return { canShutDown, shutDown };
}

export function useHeavyQueueActions(environmentId: EnvironmentId) {
  const canChange = useAtomValue(heavyQueueEnvironment.move.permissionAtom(environmentId));
  const moveCommand = useAtomCommand(heavyQueueEnvironment.move, { reportFailure: false });
  const startNowCommand = useAtomCommand(heavyQueueEnvironment.startNow, { reportFailure: false });
  const cancelCommand = useAtomCommand(heavyQueueEnvironment.cancel, { reportFailure: false });
  const pausedCommand = useAtomCommand(heavyQueueEnvironment.setPaused, { reportFailure: false });
  const ruleCommand = useAtomCommand(heavyQueueEnvironment.setRule, { reportFailure: false });
  const maxCommand = useAtomCommand(heavyQueueEnvironment.setMaxRunning, { reportFailure: false });
  const report = (title: string, result: { readonly _tag: string }) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result as never)) {
      reportFailure(title, squashAtomCommandFailure(result as never));
    }
  };
  return {
    canChange,
    move: async (id: string, beforeId: string | null) =>
      report("Could not move it", await moveCommand({ environmentId, input: { id, beforeId } })),
    startNow: async (id: string) =>
      report("Could not start it", await startNowCommand({ environmentId, input: { id } })),
    cancel: async (id: string, running: boolean) => {
      const message = running
        ? "Stop the running command? It receives a termination signal."
        : "Remove from the queue? The agent's command will stop waiting and fail.";
      if (!(await confirmKill(message))) return;
      report(
        running ? "Could not stop it" : "Could not remove from the queue",
        await cancelCommand({ environmentId, input: { id } }),
      );
    },
    setPaused: async (paused: boolean) =>
      report(
        "Could not change the queue",
        await pausedCommand({ environmentId, input: { paused } }),
      ),
    setRule: async (root: string, priority: "first" | "last" | null) =>
      report(
        "Could not change the priority",
        await ruleCommand({ environmentId, input: { root, priority } }),
      ),
    setMaxRunning: async (maxRunning: number) =>
      report(
        "Could not change the limit",
        await maxCommand({ environmentId, input: { maxRunning } }),
      ),
  };
}
