// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Route memory: a call Linux failed to run for its environment, and that then passed on this Mac,
 * `learnAfter` times goes to this Mac until the entry expires or is forgotten. `routes.json` in the queue dir, written under the
 * queue file's lock; readers take no lock, so a write replaces the file whole.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { EnvironmentFault, EnvironmentFaultKind } from "./heavyNotices.ts";
import { withLock } from "./queueFile.ts";

const DAY_MS = 86_400_000;

export interface Route {
  readonly kind: EnvironmentFaultKind;
  /** Faults seen since it was last forgotten or expired. */
  readonly faults: number;
  /** When Linux last failed it. */
  readonly at: number;
  /** The output line that showed the fault. */
  readonly line: string;
}

const routesPath = (dir: string) => NodePath.join(dir, "routes.json");

/** Runner words whose next word is the program they run: `pnpm exec playwright`. */
const RUNS_NEXT = new Set(["exec", "dlx", "x", "run"]);
/** Flags of package runners that take the next word as their value. */
const VALUE_FLAGS = new Set([
  "-C",
  "--dir",
  "--filter",
  "-F",
  "--prefix",
  "--cwd",
  "-w",
  "--workspace",
]);

/**
 * The program and the subcommand it was asked for: its basename, its first word that is no flag,
 * and after `exec`/`dlx`/`x`/`run` the one after that. `pnpm exec playwright test` →
 * `pnpm exec playwright`, `pnpm test` → `pnpm test`, `vp test run` → `vp test`.
 */
const routeCommand = ([program = "", ...args]: ReadonlyArray<string>) => {
  const words = [NodePath.basename(program)];
  for (let at = 0; at < args.length && words.length < 3; at++) {
    const arg = args[at]!;
    if (arg === "--") break;
    if (VALUE_FLAGS.has(arg)) at++;
    else if (!arg.startsWith("-")) {
      words.push(arg);
      if (!RUNS_NEXT.has(arg)) break;
    }
  }
  return words.join(" ");
};

/** `vp test@/code/app/apps/server#missing-program`: `routeCommand`, `routeFolder`, fault kind. */
export const routeKey = (
  command: ReadonlyArray<string>,
  folder: string,
  kind: EnvironmentFaultKind,
) => `${routePrefix(command, folder)}${kind}`;

const routePrefix = (command: ReadonlyArray<string>, folder: string) =>
  `${routeCommand(command)}@${folder}#`;

/** The folder of the nearest `package.json` from `cwd` up to `root`, relative to `root`; `.` for none. */
export const packageFolder = (cwd: string, root: string) => {
  for (let dir = cwd; dir.startsWith(root); dir = NodePath.dirname(dir)) {
    if (NodeFS.existsSync(NodePath.join(dir, "package.json"))) {
      return NodePath.relative(root, dir) || ".";
    }
    if (dir === root || dir === NodePath.dirname(dir)) break;
  }
  return ".";
};

/**
 * The repository `root` belongs to, the same from each of its worktrees: the main checkout of its
 * git common dir (`.git` file → `gitdir` → `commondir`), resolved; `root` when there is none.
 */
const repoOf = (root: string) => {
  const git = NodePath.join(root, ".git");
  try {
    let common = git;
    if (!NodeFS.statSync(git).isDirectory()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(NodeFS.readFileSync(git, "utf8"))?.[1];
      if (pointer === undefined) return root;
      const gitDir = NodePath.resolve(root, pointer);
      common = gitDir;
      try {
        common = NodePath.resolve(
          gitDir,
          NodeFS.readFileSync(NodePath.join(gitDir, "commondir"), "utf8").trim(),
        );
      } catch {
        // A linked gitdir without `commondir` is its own.
      }
    }
    const real = NodeFS.realpathSync(common);
    return NodePath.basename(real) === ".git" ? NodePath.dirname(real) : real;
  } catch {
    return root;
  }
};

/** What route memory keys a package by: its folder inside its repository, absolute. */
export const routeFolder = (cwd: string, root: string) =>
  NodePath.join(repoOf(root), packageFolder(cwd, root));

const isRoute = (value: unknown): value is Route =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Route).kind === "string" &&
  typeof (value as Route).faults === "number" &&
  typeof (value as Route).at === "number" &&
  typeof (value as Route).line === "string";

const readAll = (dir: string): Record<string, Route> => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(routesPath(dir), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isRoute(value)));
  } catch {
    return {};
  }
};

const live = (route: Route, now: number, days: number) => now - route.at < days * DAY_MS;

const writeAll = (dir: string, routes: Record<string, Route>) => {
  const path = routesPath(dir);
  const temp = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify(routes, null, 2));
  NodeFS.renameSync(temp, path);
};

/** The entries still in force, learned or not. */
export const listRoutes = (dir: string, now: number, days: number) =>
  Object.entries(readAll(dir)).filter(([, route]) => live(route, now, days));

/** A learned route for this command and package folder, if one is in force. */
export const learnedRoute = (
  dir: string,
  command: ReadonlyArray<string>,
  folder: string,
  now: number,
  days: number,
  learnAfter: number,
) => {
  const found = listRoutes(dir, now, days).find(
    ([key, route]) => isFor(key, command, folder) && route.faults >= learnAfter,
  );
  return found === undefined ? null : { key: found[0], route: found[1] };
};

/** Whether `key` is this command and folder's, whole: a folder `/a` never takes `/a#b`'s. */
const isFor = (key: string, command: ReadonlyArray<string>, folder: string) => {
  const prefix = routePrefix(command, folder);
  return key.startsWith(prefix) && !key.slice(prefix.length).includes("#");
};

/** Linux ran this command in this folder: its faults so far were passing ones, so they go. */
export const resetRoutes = (
  dir: string,
  command: ReadonlyArray<string>,
  folder: string,
  now: number,
  days: number,
) => {
  if (!listRoutes(dir, now, days).some(([key]) => isFor(key, command, folder))) return;
  withLock(dir, () => {
    const routes = readAll(dir);
    writeAll(
      dir,
      Object.fromEntries(Object.entries(routes).filter(([key]) => !isFor(key, command, folder))),
    );
  });
};

/** Counts one environment fault; returns the entry, learned once it reaches `learnAfter`. */
export const recordRouteFault = (
  dir: string,
  key: string,
  fault: EnvironmentFault,
  now: number,
  days: number,
  learnAfter: number,
) =>
  withLock(dir, () => {
    const routes = Object.fromEntries(listRoutes(dir, now, days));
    const route: Route = {
      kind: fault.kind,
      faults: (routes[key]?.faults ?? 0) + 1,
      at: now,
      line: fault.line,
    };
    writeAll(dir, { ...routes, [key]: route });
    return { route, learned: route.faults >= learnAfter };
  });

/** Removes one entry, or every one with `all`; the count removed. */
export const forgetRoutes = (dir: string, which: string) =>
  withLock(dir, () => {
    const routes = readAll(dir);
    const kept = Object.fromEntries(
      Object.entries(routes).filter(([key]) => which !== "all" && key !== which),
    );
    const removed = Object.keys(routes).length - Object.keys(kept).length;
    if (removed > 0) writeAll(dir, kept);
    return removed;
  });
