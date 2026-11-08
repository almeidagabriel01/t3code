import {
  ThreadWorkspaceError,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadWorkspaceRestoreResult,
  type ThreadWorkspaceStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

type ThreadShell = Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "worktreePath" | "branch">;

const isThreadWorkspaceError = Schema.is(ThreadWorkspaceError);

class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}

/** A cleaned-up thread's worktree: its status for clients, and recreation with its saved changes. */
export const makeThreadWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  const resolveRecreateBase = Effect.fn("ThreadWorkspace.resolveRecreateBase")(function* (
    cwd: string,
  ) {
    // Recovery can follow an external checkout, before the status cache expires.
    yield* gitWorkflow.invalidateLocalStatus(cwd);
    const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
    if (currentBranch !== null) {
      const refName = `refs/heads/${currentBranch}`;
      return { refName, baseRefName: refName };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "refs/remotes/origin/HEAD" })) {
      const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: "origin",
      });
      // Start from the commit so the thread branch does not track the default branch.
      return { refName: commitSha, baseRefName: "refs/remotes/origin/HEAD" };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
      return { refName: "HEAD", baseRefName: undefined };
    }
    return null;
  });

  const latestSnapshot = (cwd: string, threadId: string) =>
    gitWorkflow.latestWorktreeSnapshot({ cwd, threadId }).pipe(Effect.orElseSucceed(() => null));

  const recreateMissingWorktree = Effect.fn("ThreadWorkspace.recreateMissingWorktree")(function* (
    input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branch: string;
    },
    snapshotHeadSha: string | null,
  ) {
    const { cwd, worktreePath, branch } = input;
    yield* gitWorkflow.pruneWorktrees({ cwd });
    const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
    if (localBranchNames.includes(branch)) {
      yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
      return;
    }
    // The branch was deleted since cleanup; the snapshot's base commit is where its work was.
    if (snapshotHeadSha !== null) {
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: snapshotHeadSha,
        newRefName: branch,
        path: worktreePath,
      });
      return;
    }
    // Push keeps the tracking ref current, so recovery reads it without fetching.
    const pushedRef = `refs/remotes/origin/${branch}`;
    if (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef })) {
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: pushedRef,
        newRefName: branch,
        path: worktreePath,
      });
      return;
    }
    const base = yield* resolveRecreateBase(cwd);
    if (base === null) {
      return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
    }
    yield* gitWorkflow.createWorktree({
      cwd,
      refName: base.refName,
      newRefName: branch,
      ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
      path: worktreePath,
    });
  });

  /** Recreates the worktree, then writes the thread's snapshot into it. Nothing is left half-restored. */
  const recreate = Effect.fn("ThreadWorkspace.recreate")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly worktreePath: string;
    readonly branch: string;
  }) {
    const { cwd, worktreePath, threadId } = input;
    const snapshot = yield* latestSnapshot(cwd, threadId);
    yield* recreateMissingWorktree(input, snapshot?.headSha ?? null).pipe(
      Effect.mapError((cause) =>
        cause._tag === "WorktreeRecreateNoBaseError"
          ? cause
          : new WorktreeRecreateError({ worktreePath, branch: input.branch, cause }),
      ),
    );
    if (snapshot === null) return { restoredSnapshot: false };
    yield* gitWorkflow.restoreWorktreeSnapshot({ cwd: worktreePath, snapshot }).pipe(
      Effect.catch((cause) =>
        gitWorkflow.removeWorktree({ cwd, path: worktreePath, force: true }).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.fail(
              new ThreadWorkspaceError({
                detail: `${cause.message} Your saved changes are kept as ${snapshot.ref}.`,
                cause,
              }),
            ),
          ),
        ),
      ),
    );
    yield* gitWorkflow.dropWorktreeSnapshots({ cwd, threadId }).pipe(Effect.ignore);
    return { restoredSnapshot: true };
  });

  // Only a managed worktree folder that is missing can be restored; anything else is "ready".
  const locate = Effect.fn("ThreadWorkspace.locate")(function* (shell: ThreadShell | null) {
    if (shell === null || shell.worktreePath === null || shell.branch === null) return null;
    const { worktreePath, branch } = shell;
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists || !(yield* isManagedWorktreePath(worktreePath))) return null;
    const project = yield* projects.getById(shell.projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    if (project === null) return null;
    if (
      !(yield* gitWorkflow
        .isRepository(project.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => false)))
    )
      return null;
    return { cwd: project.workspaceRoot, worktreePath, branch };
  });

  const status = Effect.fn("ThreadWorkspace.status")(function* (
    shell: ThreadShell | null,
  ): Effect.fn.Return<ThreadWorkspaceStatus> {
    const located = yield* locate(shell);
    if (located === null || shell === null) return { state: "ready", snapshot: null };
    const snapshot = yield* latestSnapshot(located.cwd, shell.id);
    return {
      state: "cleaned",
      snapshot:
        snapshot === null
          ? null
          : { capturedAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.capturedAt)) },
    };
  });

  const restore = Effect.fn("ThreadWorkspace.restore")(function* (
    shell: ThreadShell | null,
  ): Effect.fn.Return<ThreadWorkspaceRestoreResult, ThreadWorkspaceError> {
    const first = yield* locate(shell);
    if (first === null || shell === null) return { restoredSnapshot: false };
    // A turn start holds the same lease, so one of them recreates and the other finds it present.
    return yield* withWorkspaceLease(
      path.resolve(first.worktreePath),
      Effect.gen(function* () {
        const located = yield* locate(shell);
        return located === null
          ? { restoredSnapshot: false }
          : yield* recreate({ threadId: shell.id, ...located });
      }),
    ).pipe(
      Effect.mapError((error) =>
        isThreadWorkspaceError(error)
          ? error
          : new ThreadWorkspaceError({ detail: error.message, cause: error }),
      ),
    );
  });

  return { recreate, status, restore };
});
