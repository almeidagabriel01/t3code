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

export function useKillListeningPort(environmentId: EnvironmentId | null) {
  const canKill = useAtomValue(serverEnvironment.killListeningPort.permissionAtom(environmentId));
  const command = useAtomCommand(serverEnvironment.killListeningPort, { reportFailure: false });
  const kill = async (port: ListeningPort) => {
    if (environmentId === null || port.pid === null) return;
    const name = port.processName ?? "this process";
    if (!(await confirmKill(`Kill ${name} (pid ${port.pid}) listening on port ${port.port}?`))) {
      return;
    }
    const result = await command({ environmentId, input: { pid: port.pid, port: port.port } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not kill process", squashAtomCommandFailure(result));
    }
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
