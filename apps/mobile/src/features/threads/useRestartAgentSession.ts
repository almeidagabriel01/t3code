import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import * as Dialog from "../../components/ui/Dialog";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type RestartableThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId" | "runtime" | "modelSelection" | "worktreePath"
>;

/** The web palette's "Restart agent session": end the session, then reload skills and plugins. */
export function useRestartAgentSession() {
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const projects = useProjects();
  return async (thread: RestartableThread): Promise<void> => {
    const { environmentId } = thread;
    const fail = (result: AtomCommandResult<unknown, unknown>) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not restart the agent session",
        cause instanceof Error ? cause.message : "Try again.",
      );
    };
    if (thread.runtime !== null) {
      const stopped = await stopSession({ environmentId, input: { threadId: thread.id } });
      if (stopped._tag === "Failure") return fail(stopped);
    }
    const project = projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === thread.projectId,
    );
    if (project !== undefined) {
      const refreshed = await refreshProviders({
        environmentId,
        input: {
          instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
          cwd: thread.worktreePath ?? project.workspaceRoot,
          fresh: true,
        },
      });
      if (refreshed._tag === "Failure") return fail(refreshed);
    }
    Dialog.alert("Agent session will restart", "Your next message starts a fresh session.");
  };
}
