/**
 * Mirrors the Runner settings into the queue file, where the `t3 heavy` CLI and every waiter read
 * them, and runs the Linux heartbeat. Settings stay the source; the file carries each project's
 * effective values so admission resolves a folder without a server.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  HeavyQueueError,
  RUNNER_DEFAULTS,
  RUNNER_MACHINE_KEYS,
  RUNNER_PROJECT_KEYS,
  type RunnerMachineConfig,
  type RunnerProjectConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { devWorktreeCleanupBlocked } from "../devWorktreeCleanupGuard.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as QueueFile from "./queueFile.ts";
import {
  RUNNER_COPY_RETENTION_DAYS,
  runnerCopyId,
  type HealthCheck,
  type RunnerBlock,
} from "./runner.ts";
import { checkLinux, drainLostRuns, idleRunnerCopies, removeRunnerCopy } from "./runnerExec.ts";

const pick = <K extends string>(
  source: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<K>,
) => Object.fromEntries(keys.map((key) => [key, source[key]])) as Record<K, unknown>;

/** The block for these settings and projects; pure so the publish rules are testable. */
export const runnerBlockOf = (
  settings: ServerSettings,
  projects: ReadonlyArray<{ readonly id: string; readonly workspaceRoot: string }>,
  publisher: RunnerBlock["publisher"],
): RunnerBlock => ({
  global: pick(settings, RUNNER_PROJECT_KEYS) as unknown as RunnerProjectConfig,
  machine: pick(settings, RUNNER_MACHINE_KEYS) as unknown as RunnerMachineConfig,
  projects: projects.map((project) => ({
    root: project.workspaceRoot,
    config: pick(
      resolveProjectSettings(settings, project.id as never).settings,
      RUNNER_PROJECT_KEYS,
    ) as unknown as RunnerProjectConfig,
  })),
  publisher,
});

const fingerprint = (block: RunnerBlock) => JSON.stringify(block);

export const runnerOnAnywhere = (block: RunnerBlock) =>
  block.global.runnerEnabled || block.projects.some((project) => project.config.runnerEnabled);

const sha1 = (text: string) => NodeCrypto.createHash("sha1").update(text).digest("hex");

export interface CopyOrigin {
  readonly threadId?: string;
  readonly projectId?: string;
}

/**
 * Whose checkout each `~/runs/<id>` copy is: a project's own folder, or a thread's worktree.
 * `copyIdOf` is null for a folder that is gone.
 */
export const copyOrigins = (
  projects: ReadonlyArray<{ readonly id: string; readonly workspaceRoot: string }>,
  worktrees: ReadonlyArray<{ readonly threadId: string; readonly worktreePath: string }>,
  copyIdOf: (path: string) => string | null,
): ReadonlyMap<string, CopyOrigin> => {
  const origins = new Map<string, CopyOrigin>();
  for (const project of projects) {
    const id = copyIdOf(project.workspaceRoot);
    if (id !== null) origins.set(id, { projectId: project.id });
  }
  for (const worktree of worktrees) {
    const id = copyIdOf(worktree.worktreePath);
    if (id !== null) origins.set(id, { ...origins.get(id), threadId: worktree.threadId });
  }
  return origins;
};

/** The reading with each outside item's origin from its copy; a container's own label stays. */
export const withCopyOrigins = (
  check: HealthCheck,
  origins: ReadonlyMap<string, CopyOrigin>,
): HealthCheck =>
  !check.ok || check.reading.outside === undefined
    ? check
    : {
        ...check,
        reading: {
          ...check.reading,
          outside: check.reading.outside.map((item) => {
            const origin = item.runId === undefined ? undefined : origins.get(item.runId);
            return origin === undefined ? item : { ...origin, ...item };
          }),
        },
      };

/** A folder's copy id by its real path, cached: the same path keeps its id while it exists. */
const copyIdCache = () => {
  const cache = new Map<string, string | null>();
  return (path: string) => {
    const known = cache.get(path);
    if (known !== undefined) return known;
    let id: string | null;
    try {
      id = runnerCopyId(NodeFS.realpathSync(path), sha1);
    } catch {
      id = null;
    }
    // A missing folder is asked again next time: it may be created later.
    if (id !== null) cache.set(path, id);
    return id;
  };
};

/**
 * The Linux copy to delete with a removed worktree, or null when no Runner is set up here. `remoto`
 * also runs by hand outside the Runner, so any project with the Runner on counts.
 */
export const copyRemovalFor = (
  block: RunnerBlock,
  realWorktreePath: string,
  now: number,
): QueueFile.CopyRemoval | null =>
  runnerOnAnywhere(block) && block.machine.runnerHost.trim() !== ""
    ? {
        host: block.machine.runnerHost,
        id: runnerCopyId(realWorktreePath, sha1),
        path: realWorktreePath,
        at: now,
      }
    : null;

/**
 * Tries the pending Linux copy removals for this host. A worktree recreated at the same path syncs
 * to the same copy again, so its removal is dropped. Stops at the first unreachable answer.
 */
export const drainCopyRemovals = async (
  dir: string,
  machine: RunnerBlock["machine"],
  environment: Readonly<Record<string, string | undefined>>,
  remove: typeof removeRunnerCopy = removeRunnerCopy,
) => {
  const done: QueueFile.CopyRemoval[] = [];
  for (const entry of QueueFile.readDoc(dir).copyRemovals) {
    if (entry.host !== machine.runnerHost) continue;
    if (NodeFS.existsSync(entry.path)) {
      done.push(entry);
      continue;
    }
    const result = await remove(machine, environment, entry.id);
    if (result === "removed") done.push(entry);
    if (result === "unreachable") break;
  }
  QueueFile.settleCopyRemovals(dir, done);
  return done.length;
};

const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes Linux copies idle past the retention, one at a time and only while nothing is queued: a
 * waiter's sync may start into any copy before `remoto-rodar` takes its lock. The queue is read
 * again before each removal, so a job queued mid-sweep stops it. `queued` when work kept it from
 * listing, null when Linux is unreachable.
 */
export const sweepIdleCopies = async (
  dir: string,
  machine: RunnerBlock["machine"],
  environment: Readonly<Record<string, string | undefined>>,
  now: number,
  list: typeof idleRunnerCopies = idleRunnerCopies,
  remove: typeof removeRunnerCopy = removeRunnerCopy,
): Promise<ReadonlyArray<string> | "queued" | null> => {
  const quiet = () => {
    const doc = QueueFile.readDoc(dir);
    return doc.entries.length === 0 && doc.lostRuns.length === 0;
  };
  if (!quiet()) return "queued";
  const idle = await list(machine, environment, RUNNER_COPY_RETENTION_DAYS, now);
  if (idle === null) return null;
  const removed: string[] = [];
  for (const id of idle) {
    if (!quiet()) break;
    const result = await remove(machine, environment, id);
    if (result === "unreachable") break;
    if (result === "removed") removed.push(id);
  }
  return removed;
};

/**
 * One sweep a day at most, and one at a time. The day counts from a sweep that listed: a busy
 * queue or an unreachable Linux leaves it due, so the next quiet heartbeat sweeps.
 */
export const idleSweeper = (
  dir: string,
  list: typeof idleRunnerCopies = idleRunnerCopies,
  remove: typeof removeRunnerCopy = removeRunnerCopy,
) => {
  /** In memory: a restart sweeps again, which the sweep's own rules make harmless. */
  let sweptAt = -Infinity;
  let sweeping = false;
  return async (
    machine: RunnerBlock["machine"],
    environment: Readonly<Record<string, string | undefined>>,
    now: number,
  ): Promise<ReadonlyArray<string>> => {
    if (sweeping || now - sweptAt < SWEEP_EVERY_MS) return [];
    sweeping = true;
    try {
      const result = await sweepIdleCopies(dir, machine, environment, now, list, remove);
      if (result === "queued" || result === null) return [];
      sweptAt = now;
      return result;
    } finally {
      sweeping = false;
    }
  };
};

export const layer = (
  dir: string = QueueFile.defaultQueueDir(),
  check = checkLinux,
  listIdle: typeof idleRunnerCopies = idleRunnerCopies,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const settingsService = yield* ServerSettingsService;
      const removalsBlocked = yield* devWorktreeCleanupBlocked();
      const projectStore = yield* ProjectStoreV2;
      const projections = yield* ProjectionStoreV2;
      const copyIdOf = copyIdCache();
      /** Origins only when an outside item names a copy: most beats have none. */
      const originsFor = Effect.fn("RunnerPublisher.originsFor")(
        function* (check: HealthCheck) {
          if (
            !check.ok ||
            !(check.reading.outside ?? []).some((item) => item.runId !== undefined)
          ) {
            return check;
          }
          const projects = yield* projectStore.list();
          const worktrees = yield* projections.getThreadWorktreePaths();
          return withCopyOrigins(
            check,
            copyOrigins(
              projects.map((project) => ({
                id: project.projectId,
                workspaceRoot: project.workspaceRoot,
              })),
              worktrees,
              copyIdOf,
            ),
          );
        },
        (effect, check) => Effect.orElseSucceed(effect, () => check),
      );
      const config = yield* ServerConfig;
      const publisher: RunnerBlock["publisher"] = {
        pid: process.pid,
        home: config.baseDir,
        primary: NodePath.resolve(config.baseDir) === NodePath.resolve(NodeOS.homedir(), ".t3"),
      };
      let lastPublished = "";
      let owner = false;
      let current: RunnerBlock | null = null;

      const publish = Effect.fn("RunnerPublisher.publish")(function* (settings: ServerSettings) {
        const projects = yield* projectStore.list();
        const block = runnerBlockOf(
          settings,
          projects
            .filter((project) => project.archivedAt === null)
            .map((project) => ({ id: project.projectId, workspaceRoot: project.workspaceRoot })),
          publisher,
        );
        current = block;
        const text = fingerprint(block);
        // Unchanged settings never touch the file; ownership is re-checked on each write.
        if (text === lastPublished && owner) return;
        owner = QueueFile.publishRunner(dir, block);
        if (owner) lastPublished = text;
      });

      yield* settingsService.getSettings.pipe(
        Effect.flatMap(publish),
        Effect.ignore({ log: true }),
      );
      // The host last checked; null while the Runner is off, so turning it on checks at once.
      let checkedHost: string | null = null;
      const sweepIdle = idleSweeper(dir, listIdle);
      const checkHealth = Effect.fn("RunnerPublisher.checkHealth")(function* (always: boolean) {
        const block = current;
        if (block === null || !owner || !runnerOnAnywhere(block)) {
          checkedHost = null;
          return;
        }
        if (!always && checkedHost === block.machine.runnerHost) return;
        checkedHost = block.machine.runnerHost;
        const reading = yield* originsFor(
          yield* Effect.promise(() => check(block.machine, process.env)),
        );
        yield* Effect.try({
          try: () => QueueFile.recordHealth(dir, reading),
          catch: (cause) => new HeavyQueueError({ reason: "unavailable", message: String(cause) }),
        }).pipe(Effect.ignore);
        if (reading.ok && QueueFile.readDoc(dir).lostRuns.length > 0)
          yield* Effect.tryPromise({
            try: () => drainLostRuns(dir, block.machine, process.env),
            catch: (cause) =>
              new HeavyQueueError({ reason: "unavailable", message: String(cause) }),
          }).pipe(Effect.ignore({ log: true }));
        if (reading.ok && !removalsBlocked && QueueFile.readDoc(dir).copyRemovals.length > 0)
          yield* Effect.tryPromise({
            try: () => drainCopyRemovals(dir, block.machine, process.env),
            catch: (cause) =>
              new HeavyQueueError({ reason: "unavailable", message: String(cause) }),
          }).pipe(Effect.ignore({ log: true }));
        const now = yield* Clock.currentTimeMillis;
        if (reading.ok && !removalsBlocked) {
          // Deleting copies can take minutes: it runs beside the heartbeat, never in its way.
          yield* Effect.tryPromise({
            try: () => sweepIdle(block.machine, process.env, now),
            catch: (cause) =>
              new HeavyQueueError({ reason: "unavailable", message: String(cause) }),
          }).pipe(
            Effect.flatMap((removed) =>
              removed.length === 0
                ? Effect.void
                : Effect.logInfo("Removed idle Linux copies", { removed: removed.length }),
            ),
            Effect.ignore({ log: true }),
            Effect.forkIn(scope),
          );
        }
      });

      yield* settingsService.streamChanges.pipe(
        Stream.runForEach((settings) =>
          publish(settings).pipe(Effect.andThen(checkHealth(false)), Effect.ignore({ log: true })),
        ),
        Effect.forkScoped,
      );

      // Projects come and go without a settings change; re-resolve on every heartbeat tick.
      const tick = settingsService.getSettings.pipe(
        Effect.flatMap(publish),
        Effect.ignore({ log: true }),
        Effect.andThen(checkHealth(true)),
      );
      yield* tick.pipe(
        Effect.andThen(
          Effect.suspend(() =>
            Effect.sleep(
              `${current?.machine.runnerHeartbeatSeconds ?? RUNNER_DEFAULTS.runnerHeartbeatSeconds} seconds`,
            ),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  );
