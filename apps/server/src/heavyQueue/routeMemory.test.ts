// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";

import type { EnvironmentFault } from "./heavyNotices.ts";
import {
  forgetRoutes,
  learnedRoute,
  listRoutes,
  packageFolder,
  recordRouteFault,
  routeFolder,
  routeKey,
} from "./routeMemory.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const MISSING: EnvironmentFault = { kind: "missing-program", subject: "vp", line: "vp: not found" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-routes-"));
  dirs.push(dir);
  return dir;
};

describe("route memory", () => {
  it("keys by program basename, package folder and fault kind", () => {
    const root = tempDir();
    NodeFS.mkdirSync(NodePath.join(root, "apps", "server", "src"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "apps", "server", "package.json"), "{}");
    expect(packageFolder(NodePath.join(root, "apps", "server", "src"), root)).toBe("apps/server");
    expect(packageFolder(NodePath.join(root, "apps"), root)).toBe(".");
    expect(routeKey("./node_modules/.bin/vp", "apps/server", "no-git")).toBe(
      "vp@apps/server#no-git",
    );
  });

  it("keeps each repository's package folders apart, and shares them across its worktrees", () => {
    const dir = tempDir();
    const base = NodeFS.realpathSync(tempDir());
    const repo = (name: string) => {
      const root = NodePath.join(base, name);
      NodeFS.mkdirSync(NodePath.join(root, ".git"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(root, "apps", "server"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, "apps", "server", "package.json"), "{}");
      return root;
    };
    const one = repo("one");
    const other = repo("other");
    // A worktree of `one`, as git writes it: a `.git` file, and `commondir` back to the main one.
    const worktree = NodePath.join(base, "one-wt");
    const gitDir = NodePath.join(one, ".git", "worktrees", "one-wt");
    NodeFS.mkdirSync(gitDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(gitDir, "commondir"), "../..\n");
    NodeFS.mkdirSync(NodePath.join(worktree, "apps", "server"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    NodeFS.writeFileSync(NodePath.join(worktree, "apps", "server", "package.json"), "{}");
    const folder = (root: string) => routeFolder(NodePath.join(root, "apps", "server"), root);
    const key = routeKey("vp", folder(one), "no-git");
    recordRouteFault(dir, key, MISSING, NOW, 7, 2);
    recordRouteFault(dir, key, MISSING, NOW, 7, 2);
    expect(learnedRoute(dir, "vp", folder(one), NOW, 7, 2)?.key).toBe(key);
    expect(learnedRoute(dir, "vp", folder(worktree), NOW, 7, 2)?.key).toBe(key);
    expect(learnedRoute(dir, "vp", folder(other), NOW, 7, 2)).toBeNull();
  });

  it("learns on the second fault, for that program and folder only", () => {
    const dir = tempDir();
    const key = routeKey("vp", ".", "missing-program");
    expect(recordRouteFault(dir, key, MISSING, NOW, 7, 2).learned).toBe(false);
    expect(learnedRoute(dir, "vp", ".", NOW, 7, 2)).toBeNull();
    expect(recordRouteFault(dir, key, MISSING, NOW + 1, 7, 2).learned).toBe(true);
    expect(learnedRoute(dir, "/x/vp", ".", NOW + 2, 7, 2)?.key).toBe(key);
    expect(learnedRoute(dir, "vp", "apps/web", NOW + 2, 7, 2)).toBeNull();
    expect(learnedRoute(dir, "pnpm", ".", NOW + 2, 7, 2)).toBeNull();
  });

  it("expiry and forget bring Linux back", () => {
    const dir = tempDir();
    const key = routeKey("vp", ".", "missing-program");
    recordRouteFault(dir, key, MISSING, NOW, 7, 2);
    recordRouteFault(dir, key, MISSING, NOW, 7, 2);
    expect(learnedRoute(dir, "vp", ".", NOW + 6 * DAY, 7, 2)).not.toBeNull();
    expect(learnedRoute(dir, "vp", ".", NOW + 7 * DAY, 7, 2)).toBeNull();
    expect(listRoutes(dir, NOW + 7 * DAY, 7)).toEqual([]);
    // A fault after it expired starts counting again.
    expect(recordRouteFault(dir, key, MISSING, NOW + 8 * DAY, 7, 2).route.faults).toBe(1);
    recordRouteFault(dir, key, MISSING, NOW + 8 * DAY, 7, 2);
    expect(forgetRoutes(dir, "vp@.#no-git")).toBe(0);
    expect(forgetRoutes(dir, key)).toBe(1);
    expect(learnedRoute(dir, "vp", ".", NOW + 8 * DAY, 7, 2)).toBeNull();
    recordRouteFault(dir, routeKey("pnpm", ".", "no-git"), MISSING, NOW, 7, 2);
    expect(forgetRoutes(dir, "all")).toBe(1);
    expect(listRoutes(dir, NOW, 7)).toEqual([]);
  });

  it("reads a damaged file as empty and keeps only well-formed entries", () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, "routes.json"), "{not json");
    expect(listRoutes(dir, NOW, 7)).toEqual([]);
    NodeFS.writeFileSync(
      NodePath.join(dir, "routes.json"),
      JSON.stringify({ bad: { faults: "2" }, "vp@.#no-git": { ...MISSING, faults: 2, at: NOW } }),
    );
    expect(listRoutes(dir, NOW, 7).map(([key]) => key)).toEqual(["vp@.#no-git"]);
  });

  it("two concurrent writers keep both entries and every count", async () => {
    const dir = tempDir();
    const module = NodeURL.fileURLToPath(new URL("./routeMemory.ts", import.meta.url));
    const writer = (key: string) =>
      new Promise<number | null>((resolve) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const { recordRouteFault } = await import(${JSON.stringify(module)});
             for (let i = 0; i < 25; i++)
               recordRouteFault(${JSON.stringify(dir)}, ${JSON.stringify(key)}, ${JSON.stringify(MISSING)}, ${NOW}, 7, 2);`,
          ],
          { stdio: "inherit" },
        );
        child.on("exit", resolve);
      });
    expect(await Promise.all([writer("vp@.#a"), writer("pnpm@.#b")])).toEqual([0, 0]);
    expect(
      Object.fromEntries(listRoutes(dir, NOW, 7).map(([key, route]) => [key, route.faults])),
    ).toEqual({ "vp@.#a": 25, "pnpm@.#b": 25 });
  });
});
