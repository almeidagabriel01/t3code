// @effect-diagnostics nodeBuiltinImport:off - The Bash hook decides synchronously, before the call runs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { readLine } from "./heavyHook.ts";

/** The hooks a plain `git commit` runs before it records anything. */
const COMMIT_HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg"];
/** husky 9 and vite-plus: `_/<hook>` only sources `_/h`, which runs `../<hook>` when that file exists. */
const SHIM = /^\.\s+"\$\(dirname\s+(--\s+)?"\$0"\)\/h"\s*$/m;

const isFile = (path: string) => {
  try {
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

const runs = (dir: string, name: string) => {
  const path = NodePath.join(dir, name);
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    if (!NodeFS.statSync(path).isFile()) return false;
    return !SHIM.test(NodeFS.readFileSync(path, "utf8")) || isFile(NodePath.join(dir, "..", name));
  } catch {
    return false;
  }
};

/**
 * Whether `git commit` in `cwd` runs a hook, found where git looks: `core.hooksPath` (relative to
 * the worktree top), else the common git dir's `hooks/`, so worktrees share it. Only an executable
 * file counts, never a `.sample`. Outside a repository nothing runs; when git cannot answer at all,
 * a hook is assumed, which keeps the commit queued as before.
 */
const commitHookRuns = (cwd: string) => {
  const found = NodeChildProcess.spawnSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd,
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (found.error !== undefined) return true;
  if (found.status !== 0) return false;
  const dir = NodePath.resolve(cwd, found.stdout.trim());
  return COMMIT_HOOKS.some((name) => runs(dir, name));
};

export const COMMIT_RUNS_DIRECT = "No commit hook in this repository: runs directly";

/**
 * How a line whose only work is `git commit` runs from `cwd`: "direct" when no commit hook runs
 * there, "first" (queued ahead of other waiters) when one does. Null for any other line, which the
 * queue handles as usual. `git commit -n` is not work, so it never reaches here.
 */
export const commitRoute = (line: string, cwd: string): "direct" | "first" | null => {
  const work = readLine(line).parts.filter((part) => part.heavy);
  const commitsOnly =
    work.length > 0 &&
    work.every(
      (part) =>
        part.nested === null &&
        part.remoto === null &&
        part.program === "git" &&
        part.words[0] === "commit",
    );
  if (!commitsOnly) return null;
  return commitHookRuns(cwd) ? "first" : "direct";
};
