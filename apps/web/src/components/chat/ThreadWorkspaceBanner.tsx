import { describeCleanedWorkspace } from "@t3tools/client-runtime/threadWorkspace";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArchiveRestoreIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { useThreadWorkspaceRestore } from "./useThreadWorkspaceRestore";

/** Shown while a thread's managed worktree folder is gone; sending a message restores it too. */
export function ThreadWorkspaceBanner(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  worktreePath: string | null;
  /** Changes when a turn starts or ends, the moments a restore can have happened. */
  turnKey: string;
}) {
  const workspace = useThreadWorkspaceRestore(props);
  const { cleaned, refresh } = workspace;
  const seenTurnKey = useRef(props.turnKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server restores the worktree on turn start, outside this query
  useEffect(() => {
    if (seenTurnKey.current === props.turnKey) return;
    seenTurnKey.current = props.turnKey;
    refresh();
  }, [props.turnKey, refresh]);
  if (cleaned === null) return null;

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="info" surface="glass" controlAlignment="first-line">
        <ArchiveRestoreIcon />
        <AlertDescription>
          <p>{describeCleanedWorkspace(cleaned)}</p>
          <p>Sending a message restores it as well.</p>
          {workspace.error !== null && <p className="text-error-foreground">{workspace.error}</p>}
        </AlertDescription>
        <AlertAction>
          <Button
            variant="default"
            size="sm"
            disabled={workspace.pending || !workspace.canRestore}
            onClick={() => void workspace.run()}
          >
            {workspace.pending ? "Restoring…" : "Restore"}
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
