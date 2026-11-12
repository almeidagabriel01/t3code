import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";

export const DEV_WORKTREE_CLEANUP_ENV = "T3CODE_DEV_WORKTREE_CLEANUP";

/**
 * Dev and test servers seed the developer's real projects, whose repositories hold real worktrees,
 * so they never delete worktrees, their snapshots or Linux copies unless asked to by
 * `T3CODE_DEV_WORKTREE_CLEANUP=1`. A dev server has a dev web URL; a test or scenario server runs
 * from a home inside a checkout (`<worktree>/.t3`, `<worktree>/.t3/<name>`).
 */
export const devWorktreeCleanupBlocked = Effect.fn("DevWorktreeCleanupGuard.blocked")(function* () {
  const environment = yield* HostProcess.Environment;
  if (environment[DEV_WORKTREE_CLEANUP_ENV] === "1") return false;
  const config = yield* ServerConfig.ServerConfig;
  if (config.devUrl !== undefined) return true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.resolve(yield* HostProcess.HomeDirectory);
  // The user's home may itself be a dotfiles repository; only a checkout below it counts.
  let directory = path.dirname(path.resolve(config.baseDir));
  while (directory !== home && path.dirname(directory) !== directory) {
    if (yield* fs.exists(path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => true)))
      return true;
    directory = path.dirname(directory);
  }
  return false;
});
