import { describeCleanedWorkspace } from "@t3tools/client-runtime/threadWorkspace";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArchiveRestoreIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./threadDetailsPanelStyles";
import {
  type ThreadWorkspaceRestore,
  useThreadWorkspaceRestore,
} from "./useThreadWorkspaceRestore";

/** Fills a right-panel surface whose folder is gone, in place of its "not a repository" or error state. */
function ThreadWorkspaceCleanedState({ workspace }: { workspace: ThreadWorkspaceRestore }) {
  if (workspace.cleaned === null) return null;
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-xs text-muted-foreground">
      <ArchiveRestoreIcon className="size-5" aria-hidden />
      <p className="max-w-sm">{describeCleanedWorkspace(workspace.cleaned)}</p>
      {workspace.error !== null && <p className="max-w-sm text-destructive">{workspace.error}</p>}
      <Button
        variant="default"
        size="sm"
        disabled={workspace.pending || !workspace.canRestore}
        onClick={() => void workspace.run()}
      >
        {workspace.pending ? "Restoring…" : "Restore"}
      </Button>
    </div>
  );
}

/** The thread details panel's git row while the worktree is cleaned up; it replaces Initialize Git. */
export function ThreadWorkspaceCleanedRow({ workspace }: { workspace: ThreadWorkspaceRestore }) {
  if (workspace.cleaned === null) return null;
  return (
    <>
      <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
        {describeCleanedWorkspace(workspace.cleaned)}
      </p>
      {workspace.error !== null && (
        <p className="px-2.5 pb-1.5 text-xs text-destructive">{workspace.error}</p>
      )}
      <ThreadDetailsControl
        size="xs"
        variant="ghost"
        part="row"
        panel
        disabled={workspace.pending || !workspace.canRestore}
        onClick={() => void workspace.run()}
      >
        <ArchiveRestoreIcon className="size-3.5" aria-hidden />
        <span className={cn("ml-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {workspace.pending ? "Restoring…" : "Restore"}
        </span>
      </ThreadDetailsControl>
    </>
  );
}

/** Shows the cleaned-up state instead of a surface that reads the thread's worktree folder. */
export function ThreadWorkspaceCleanedGate(props: {
  threadRef: ScopedThreadRef;
  /** The folder the surface reads; only the thread's own worktree is gated. */
  cwd: string | undefined;
  children: ReactNode;
}) {
  const shell = useQuietThreadShell(props.threadRef);
  const worktreePath = shell?.worktreePath ?? null;
  const workspace = useThreadWorkspaceRestore({
    environmentId: props.threadRef.environmentId,
    threadId: props.threadRef.threadId,
    worktreePath: worktreePath !== null && worktreePath === props.cwd ? worktreePath : null,
  });
  return workspace.cleaned === null ? (
    props.children
  ) : (
    <ThreadWorkspaceCleanedState workspace={workspace} />
  );
}
