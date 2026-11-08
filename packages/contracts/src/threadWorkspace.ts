import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const ThreadWorkspaceInput = Schema.Struct({ threadId: ThreadId });
export type ThreadWorkspaceInput = typeof ThreadWorkspaceInput.Type;

/**
 * `cleaned`: the thread's managed worktree folder is gone and can be recreated. `snapshot` is the
 * saved uncommitted work Restore brings back, or null when none was taken or it expired.
 */
export const ThreadWorkspaceStatus = Schema.Struct({
  state: Schema.Literals(["ready", "cleaned"]),
  snapshot: Schema.NullOr(Schema.Struct({ capturedAt: IsoDateTime })),
});
export type ThreadWorkspaceStatus = typeof ThreadWorkspaceStatus.Type;

export const ThreadWorkspaceRestoreResult = Schema.Struct({
  /** False when the worktree was recreated from its branch alone. */
  restoredSnapshot: Schema.Boolean,
});
export type ThreadWorkspaceRestoreResult = typeof ThreadWorkspaceRestoreResult.Type;

export class ThreadWorkspaceError extends Schema.TaggedError<ThreadWorkspaceError>()(
  "ThreadWorkspaceError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}
