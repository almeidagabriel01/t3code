import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { describeCleanedWorkspace } from "@t3tools/client-runtime/threadWorkspace";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArchiveRestoreIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

/** Shown while a thread's managed worktree folder is gone; sending a message restores it too. */
export function ThreadWorkspaceBanner(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  worktreePath: string | null;
  /** Changes when a turn starts or ends, the moments a restore can have happened. */
  turnKey: string;
}) {
  const query = useEnvironmentQuery(
    props.worktreePath === null
      ? null
      : serverEnvironment.threadWorkspaceStatus({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        }),
  );
  const restore = useAtomCommand(serverEnvironment.restoreThreadWorkspace, {
    reportFailure: false,
  });
  const canRestore = useAtomValue(
    serverEnvironment.restoreThreadWorkspace.permissionAtom(props.environmentId),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = query;
  const seenTurnKey = useRef(props.turnKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server restores the worktree on turn start, outside this query
  useEffect(() => {
    if (seenTurnKey.current === props.turnKey) return;
    seenTurnKey.current = props.turnKey;
    refresh();
  }, [props.turnKey, refresh]);
  if (query.data?.state !== "cleaned") return null;

  const run = async () => {
    setPending(true);
    setError(null);
    const result = await restore({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not restore the worktree.");
      return;
    }
    refresh();
  };

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="info" surface="glass" controlAlignment="first-line">
        <ArchiveRestoreIcon />
        <AlertDescription>
          <p>{describeCleanedWorkspace(query.data)}</p>
          <p>Sending a message restores it as well.</p>
          {error !== null && <p className="text-error-foreground">{error}</p>}
        </AlertDescription>
        <AlertAction>
          <Button
            variant="default"
            size="sm"
            disabled={pending || !canRestore}
            onClick={() => void run()}
          >
            {pending ? "Restoring…" : "Restore"}
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
