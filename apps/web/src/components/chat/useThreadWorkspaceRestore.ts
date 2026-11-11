import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";

/** A thread's managed worktree status and the one Restore action every surface offers for it. */
export function useThreadWorkspaceRestore(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  worktreePath: string | null;
}) {
  const { environmentId, threadId, worktreePath } = props;
  const query = useEnvironmentQuery(
    worktreePath === null
      ? null
      : serverEnvironment.threadWorkspaceStatus({ environmentId, input: { threadId } }),
  );
  const restore = useAtomCommand(serverEnvironment.restoreThreadWorkspace, {
    reportFailure: false,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const canRestore = useAtomValue(
    serverEnvironment.restoreThreadWorkspace.permissionAtom(environmentId),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = query;

  const run = async () => {
    setPending(true);
    setError(null);
    const result = await restore({ environmentId, input: { threadId } });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not restore the worktree.");
      return;
    }
    refresh();
    // The git reading for the folder still says "not a repository" until it is read again.
    if (worktreePath !== null) {
      void refreshVcsStatus({ environmentId, input: { cwd: worktreePath } });
    }
  };

  return {
    status: query.data,
    cleaned: query.data?.state === "cleaned" ? query.data : null,
    refresh,
    canRestore,
    pending,
    error,
    run,
  };
}

export type ThreadWorkspaceRestore = ReturnType<typeof useThreadWorkspaceRestore>;
