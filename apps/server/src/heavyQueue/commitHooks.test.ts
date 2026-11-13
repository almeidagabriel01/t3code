// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { commitRoute } from "./commitHooks.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, stdio: "ignore" });

const write = (path: string, text: string, mode = 0o755) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, text, { mode });
};

const SHIM = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

/** A fresh repository with git's own `.sample` hooks, set up by `arrange`; returns where to commit from. */
const repo = (arrange: (root: string) => string | void) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-commit-hooks-"));
  roots.push(root);
  git(root, "init", "-q");
  return NodePath.resolve(root, arrange(root) ?? ".");
};

describe("commitRoute", () => {
  it.each<[string, (root: string) => string | void, string, "direct" | "first" | null]>([
    [
      "no hooks folder",
      (root) => NodeFS.rmSync(`${root}/.git/hooks`, { recursive: true }),
      "git commit -m x",
      "direct",
    ],
    ["only .sample hooks", () => {}, "git commit -m x", "direct"],
    [
      "a pre-commit that is not executable",
      (root) => write(`${root}/.git/hooks/pre-commit`, "exit 1", 0o644),
      "git commit -m x",
      "direct",
    ],
    [
      "an executable pre-commit",
      (root) => write(`${root}/.git/hooks/pre-commit`, "exit 0"),
      "git commit -m x",
      "first",
    ],
    [
      "an executable commit-msg",
      (root) => write(`${root}/.git/hooks/commit-msg`, "exit 0"),
      "git commit -am x",
      "first",
    ],
    [
      "husky-style hooksPath whose pre-commit exists",
      (root) => {
        git(root, "config", "core.hooksPath", ".husky/_");
        write(`${root}/.husky/_/pre-commit`, SHIM);
        write(`${root}/.husky/_/h`, "exit 0");
        write(`${root}/.husky/pre-commit`, "vp staged", 0o644);
      },
      "git commit -m x",
      "first",
    ],
    [
      "husky-style hooksPath with only the shims",
      (root) => {
        git(root, "config", "core.hooksPath", ".husky/_");
        write(`${root}/.husky/_/pre-commit`, SHIM);
        write(`${root}/.husky/_/commit-msg`, SHIM);
        write(`${root}/.husky/_/h`, "exit 0");
      },
      "git commit -m x",
      "direct",
    ],
    [
      "a relative hooksPath, committed from a subfolder",
      (root) => {
        git(root, "config", "core.hooksPath", "tools/hooks");
        write(`${root}/tools/hooks/pre-commit`, "exit 0");
        NodeFS.mkdirSync(`${root}/src`);
        return "src";
      },
      "git commit -m x",
      "first",
    ],
    [
      "a worktree, whose hooks live in the common git dir",
      (root) => {
        git(
          root,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "-q",
          "--allow-empty",
          "-n",
          "-m",
          "i",
        );
        git(root, "worktree", "add", "-q", "wt");
        write(`${root}/.git/hooks/pre-commit`, "exit 0");
        return "wt";
      },
      "git commit -m x",
      "first",
    ],
    [
      "outside any repository",
      (root) => NodeFS.rmSync(`${root}/.git`, { recursive: true }),
      "git commit -m x",
      "direct",
    ],
    ["a commit inside a longer line", () => {}, "git add . && git commit -m x", "direct"],
    [
      "git's own -c before commit",
      (root) => write(`${root}/.git/hooks/pre-commit`, "exit 0"),
      "git -c user.name=t -c core.quotePath=off commit -m x",
      "first",
    ],
    [
      "-C names a repository with a hook",
      (root) => {
        git(root, "init", "-q", "inner");
        write(`${root}/inner/.git/hooks/pre-commit`, "exit 0");
      },
      "git -C inner commit -m x",
      "first",
    ],
    [
      "-C names a hookless repository inside a hooked one",
      (root) => {
        write(`${root}/.git/hooks/pre-commit`, "exit 0");
        git(root, "init", "-q", "inner");
      },
      "git -C inner -c k=v commit -m x",
      "direct",
    ],
    ["-n after git's own options", () => {}, "git -C . commit -n -m x", null],
    // Not a commit-only line: the queue decides as before.
    [
      "--no-verify skips the hooks",
      (root) => write(`${root}/.git/hooks/pre-commit`, "exit 0"),
      "git commit -n -m x",
      null,
    ],
    ["other work beside the commit", () => {}, "vp test run && git commit -m x", null],
    ["a commit in a nested shell", () => {}, "sh -c 'git commit -m x'", null],
    ["an agent's own remoto", () => {}, "remoto git commit -m x", null],
  ])("%s", (_name, arrange, line, expected) => {
    expect(commitRoute(line, repo(arrange))).toBe(expected);
  });
});
