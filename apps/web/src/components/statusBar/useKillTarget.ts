import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ListeningPort,
  type TerminalCloseInput,
} from "@t3tools/contracts";

import { ensureLocalApi } from "../../localApi";
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
