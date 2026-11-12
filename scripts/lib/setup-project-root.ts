// @effect-diagnostics nodeBuiltinImport:off - worktree setup runs before `vp i`, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

/**
 * The checkout whose env files a worktree links. T3's setup action names it; run any
 * other way, git's common directory gives the main checkout.
 */
export function resolveSetupProjectRoot(
  worktree: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (env.T3CODE_PROJECT_ROOT) return env.T3CODE_PROJECT_ROOT;
  const commonDir = NodeChildProcess.execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: worktree, encoding: "utf8", env: { ...env } },
  ).trim();
  return NodePath.dirname(commonDir);
}
