// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { resolveSetupProjectRoot } from "./setup-project-root.ts";

// Hooks export GIT_DIR, and user config can sign commits.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: NodeOS.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  T3CODE_PROJECT_ROOT: undefined,
};
const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-setup-")));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
const main = NodePath.join(root, "main");
const worktree = NodePath.join(root, "worktrees", "t3-1");
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: main, env, stdio: "ignore" });
NodeFS.mkdirSync(main);
git("init", "-q");
git("commit", "-q", "--allow-empty", "-m", "init");
git("worktree", "add", "-q", worktree);

describe("resolveSetupProjectRoot", () => {
  it.each([
    ["a linked worktree", worktree],
    ["the main checkout", main],
  ])("finds the main checkout from %s when T3 does not name it", (_name, cwd) => {
    expect(resolveSetupProjectRoot(cwd, env)).toBe(main);
  });

  it("prefers the project root T3's setup action names", () => {
    expect(
      resolveSetupProjectRoot(worktree, { ...env, T3CODE_PROJECT_ROOT: "/projects/app" }),
    ).toBe("/projects/app");
  });
});
