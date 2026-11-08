import type { ThreadWorkspaceStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const savedOn = (capturedAt: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    DateTime.toEpochMillis(DateTime.makeUnsafe(capturedAt)),
  );

/** The banner sentence for a cleaned-up worktree; `snapshot` null means nothing was saved or it expired. */
export function describeCleanedWorkspace(status: ThreadWorkspaceStatus): string {
  return status.snapshot === null
    ? "This thread's worktree was cleaned up. No saved changes remain, so Restore recreates it from its branch."
    : `This thread's worktree was cleaned up. Restore brings back the changes saved on ${savedOn(status.snapshot.capturedAt)}.`;
}
