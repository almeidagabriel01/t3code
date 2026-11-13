import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "./processRunner.ts";
import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

/** How long a worktree's files must sit untouched before cleanup counts it as no longer in use. */
export const QUIET_MS = 5 * 60 * 1_000;
const MAX_CHECKED_FILES = 200_000;

/** `lsof -F n` prints one `n<path>` line per selected file after each `p<pid>` line. */
export const parseLsofCwds = (output: string) =>
  output
    .split("\n")
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1));

/**
 * The working directory of every process this user can see, or null when the system cannot say.
 * Windows refuses to delete a folder that is any process's working directory, so removal there
 * fails on its own instead of pulling the folder out from under the process.
 */
export const listProcessCwds = Effect.fn("WorktreeQuiet.listProcessCwds")(
  function* () {
    if (yield* HostProcess.isWindows) return [] as ReadonlyArray<string>;
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists("/proc/self/cwd")) {
      const cwds: string[] = [];
      for (const name of yield* fs.readDirectory("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        // Processes that exit mid-scan, or belong to other users, have nothing to read.
        const cwd = yield* fs.readLink(`/proc/${name}/cwd`).pipe(Effect.orElseSucceed(() => null));
        if (cwd !== null) cwds.push(cwd);
      }
      return cwds;
    }
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner.run({
      command: "lsof",
      args: ["-w", "-d", "cwd", "-F", "n"],
      timeout: "20 seconds",
      maxOutputBytes: 16 * 1024 * 1024,
    });
    const cwds = parseLsofCwds(result.stdout);
    // lsof exits 1 when it could not inspect some process; an empty answer is no answer.
    if (result.stdoutTruncated || cwds.length === 0) return null;
    return cwds;
  },
  Effect.orElseSucceed(() => null),
);

/**
 * The first file in the worktree, tracked or untracked but not ignored, changed after `since`.
 * "too many files" when the worktree is too large to check, which callers treat as busy.
 */
export const recentlyChangedFile = Effect.fn("WorktreeQuiet.recentlyChangedFile")(function* (
  execute: GitVcsDriver.GitVcsDriver["Service"]["execute"],
  worktreePath: string,
  since: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listed = yield* execute({
    operation: "WorktreeQuiet.recentlyChangedFile",
    cwd: worktreePath,
    args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    maxOutputBytes: 64 * 1024 * 1024,
  });
  const files = listed.stdout.split("\0").filter(Boolean);
  if (listed.stdoutTruncated || files.length > MAX_CHECKED_FILES) return "too many files";
  const changed = yield* Effect.forEach(
    [...new Set(files)],
    (file) =>
      fs.stat(path.join(worktreePath, file)).pipe(
        Effect.map((stat) =>
          (Option.getOrNull(stat.mtime)?.getTime() ?? 0) > since ? file : null,
        ),
        // Deleted tracked files are a local change the caller already refused.
        Effect.orElseSucceed(() => null),
      ),
    { concurrency: 32 },
  );
  return changed.find((file) => file !== null) ?? null;
});
