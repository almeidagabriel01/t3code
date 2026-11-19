import { localGitOnly } from "./heavyHook.ts";

export const COMMIT_RUNS_DIRECT = "A local git write: runs directly";

/**
 * "direct" for a line whose only work is local git (a commit, merge or rebase): it is quick even
 * with hooks, which edit this Mac's checkout, so it never waits for a slot. Null for any other line.
 */
export const commitRoute = (line: string): "direct" | null =>
  localGitOnly(line) ? "direct" : null;
