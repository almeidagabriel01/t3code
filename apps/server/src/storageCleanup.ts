import {
  GitCommandError,
  HeavyQueueError,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  OrchestrationProjectShell,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
  StorageCleanupReport,
  StorageCleanupReportEntry,
  ThreadId,
  WorktreeFinishKeptReason,
  WorktreeMcpFinishResult,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { parse as parseYaml } from "yaml";

import * as ServerConfig from "./config.ts";
import { devWorktreeCleanupBlocked } from "./devWorktreeCleanupGuard.ts";
import * as QueueFile from "./heavyQueue/queueFile.ts";
import { copyRemovalFor, drainCopyRemovals, runnerBlockOf } from "./heavyQueue/RunnerPublisher.ts";
import { terminalRunStatuses } from "./memory/memoryCatchUpWakes.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "./worktreesDirectory.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { removeLinkedWorktree } from "./vcs/worktreeRemoval.ts";
import { captureWorktreeSnapshot, pruneWorktreeSnapshots } from "./vcs/worktreeSnapshot.ts";
import {
  integratedInto,
  listWorktrees,
  markWorktreeFinished,
  worktreeAdminDir,
  worktreeFinished,
  worktreeTimes,
} from "./vcs/worktreeIntegration.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import { listProcessCwds, QUIET_MS, recentlyChangedFile } from "./worktreeQuiet.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { isNetworkPath } from "@t3tools/shared/path";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
// pnpm 11 writes this file as JSON, older versions as YAML.
const decodePnpmModulesManifest = Schema.decodeUnknownEffect(
  Schema.Struct({
    storeDir: Schema.String,
    virtualStoreDir: Schema.optional(Schema.String),
  }),
);

class PnpmModulesManifestParseError extends Schema.TaggedError<PnpmModulesManifestParseError>()(
  "PnpmModulesManifestParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not parse the pnpm modules manifest.";
  }
}

const DAY_MS = 86_400_000;
// Give settle scripts time to open terminals that protect the worktree.
const SETTLE_SCRIPT_GRACE_MS = 60_000;
// Worktree creation can precede its thread row, including review-guide checkouts.
const ORPHAN_WORKTREE_GRACE_MS = 60 * 60 * 1_000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const REPORT_ENTRY_LIMIT = 200;
const isGitCommandError = Schema.is(GitCommandError);

function cleanupFailureReason(error: { readonly message: string }) {
  return isGitCommandError(error)
    ? `${error.command}: ${error.detail.split(/\r?\n/)[0]}${error.reason ? ` (${error.reason})` : ""}`
    : (error.message.split(/\r?\n/)[0] ?? error.message);
}

const mergedCleanupEnabled = (rules: WorktreeCleanupRules) => rules.worktreeMerged !== "off";

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeSettledAfterDays !== null ||
  rules.worktreeOnDelete ||
  mergedCleanupEnabled(rules);

const DEV_BLOCKED_REASON =
  "Worktree cleanup is off on development servers; set T3CODE_DEV_WORKTREE_CLEANUP=1 to allow it";

/** Why a worktree stayed, in the terms `t3_worktree_finish` reports. */
type KeepCode = "busy" | "not-due" | "dirty" | "not-integrated" | "off" | "other";

interface Decision {
  readonly outcome: StorageCleanupReportEntry["outcome"];
  readonly code: KeepCode;
  readonly reason: string;
  readonly projectId: ProjectId | null;
}

/** null project ids sweep everything; a full sweep also fetches, reports and prunes. */
interface SweepScope {
  readonly projectIds: ReadonlySet<ProjectId> | null;
  readonly worktreePath: string | null;
}

const FULL_SWEEP: SweepScope = { projectIds: null, worktreePath: null };

export class WorktreeFinishError extends Schema.TaggedError<WorktreeFinishError>()(
  "WorktreeFinishError",
  {
    reason: Schema.Literals(["thread-not-found", "project-not-found", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "thread-not-found"
      ? "The thread was not found."
      : this.reason === "project-not-found"
        ? "The thread's project was not found."
        : "Worktree cleanup could not check this worktree.";
  }
}

const finishResult = (
  worktreePath: string,
  decision: Pick<Decision, "outcome" | "code" | "reason"> | undefined,
  exists: boolean,
): WorktreeMcpFinishResult => {
  if (decision?.outcome === "removed")
    return {
      status: "removed",
      worktreePath,
      detail: "Removed now. Its branch stays.",
    };
  if (decision === undefined && !exists)
    return { status: "gone", worktreePath, detail: "The worktree no longer exists." };
  if (decision?.outcome === "kept" && (decision.code === "busy" || decision.code === "not-due"))
    return {
      status: "scheduled",
      worktreePath,
      detail: `Its work is in the default branch. T3 removes it once nothing uses it (now: ${decision.reason}).`,
    };
  const reason: WorktreeFinishKeptReason =
    decision?.outcome !== "kept"
      ? "other"
      : decision.code === "dirty"
        ? "uncommitted-changes"
        : decision.code === "not-integrated"
          ? "not-integrated"
          : decision.code === "off"
            ? "cleanup-off"
            : "other";
  return {
    status: "kept",
    worktreePath,
    reason,
    detail: sentence(decision?.reason ?? "It is not a worktree cleanup can remove"),
  };
};

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

type LimitRecoverySettings = Pick<
  ServerSettings,
  "autoResumeLimitedThreads" | "snoozeLimitedThreads"
>;

export function storageCleanupThreadIdle(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  return thread.worktreePath !== null && threadIdle(thread, now, settings);
}

function threadIdle(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  return (
    thread.activeRunId === null &&
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "interrupted" ||
      thread.status === "failed" ||
      thread.status === "cancelled" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now) &&
    !heldForLimitRecovery(thread, now, settings)
  );
}

// A run held for its usage-limit reset has its work still ahead of it, and a
// fresh worktree would otherwise look unchanged and be removed before it runs.
function heldForLimitRecovery(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled"
  )
    return false;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  const recovery = thread.limitRecovery;
  if (recovery?.runId === thread.latestRunId && recovery.resetAt === thread.usageLimitResetAt)
    // An auto-resume holds until its continuation replaces the failed run.
    return recovery.autoResume || (recovery.snooze === true && resetMs > now);
  // The recovery worker arms this failure on a later tick; hold it until then.
  // Like the worker, skip a reset that had already passed when the run ended.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return false;
  return settings.autoResumeLimitedThreads || (settings.snoozeLimitedThreads && resetMs > now);
}

/** PR metadata refreshes must not reset the inactivity clock. */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

/** Only a complete subagent or side chat chain within this worktree shares ownership. */
function worktreeOwner<T extends Pick<OrchestrationV2ThreadShell, "id" | "lineage">>(
  threads: ReadonlyArray<T>,
) {
  if (threads.length === 1) return threads[0];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const tops = threads.filter((thread) => !byId.has(thread.lineage.parentThreadId!));
  if (tops.length !== 1) return undefined;
  const owner = tops[0]!;
  for (const thread of threads) {
    let current = thread;
    const seen = new Set<string>();
    while (current.id !== owner.id) {
      if (
        seen.has(current.id) ||
        (current.lineage.relationshipToParent !== "subagent" &&
          current.lineage.sideChat !== true) ||
        current.lineage.rootThreadId !== owner.lineage.rootThreadId
      )
        return undefined;
      seen.add(current.id);
      const parent = byId.get(current.lineage.parentThreadId!);
      if (parent === undefined) return undefined;
      current = parent;
    }
  }
  return owner;
}

function worktreeSettlementChain(
  thread: OrchestrationV2ThreadShell,
  byId: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
  now: number,
  settings: LimitRecoverySettings,
) {
  const chain = [thread];
  let current = thread;
  while (current.settledAt === null) {
    if (
      current.lineage.relationshipToParent !== "subagent" ||
      current.settledOverride === "active" ||
      current.pinnedAt != null
    )
      return [];
    const parent = byId.get(current.lineage.parentThreadId!);
    if (
      parent === undefined ||
      chain.some((member) => member.id === parent.id) ||
      parent.projectId !== thread.projectId ||
      parent.lineage.rootThreadId !== thread.lineage.rootThreadId ||
      !threadIdle(parent, now, settings)
    )
      return [];
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** Squash/rebase merges require the merged PR to name this exact head commit. */
export function storageCleanupPullRequestMerged(
  pullRequest: Pick<
    GitManager.GitBranchPullRequest,
    "state" | "headRef" | "baseRef" | "headSha"
  > | null,
  worktree: {
    readonly branch: string;
    readonly defaultBranch: string;
    readonly headSha: string;
    readonly integrated: boolean;
  },
): boolean {
  return (
    pullRequest?.state === "merged" &&
    (worktree.integrated ||
      (pullRequest.headRef === worktree.branch &&
        pullRequest.baseRef === worktree.defaultBranch &&
        pullRequest.headSha === worktree.headSha))
  );
}

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly runNow: Effect.Effect<StorageCleanupReport, ServerSettingsError>;
    readonly latestReport: Effect.Effect<StorageCleanupReport | null>;
    readonly reports: Stream.Stream<StorageCleanupReport | null>;
    readonly drain: Effect.Effect<void>;
    /**
     * An agent says its worktree's work is in the repository: mark it finished, so it is removed
     * once integrated and unused whatever the waiting period, and sweep its project now.
     */
    readonly finishWorktree: (input: {
      readonly threadId: ThreadId;
      readonly worktreePath?: string | undefined;
    }) => Effect.Effect<WorktreeMcpFinishResult, WorktreeFinishError>;
  }
>()("t3/storageCleanup") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const devBlocked = yield* devWorktreeCleanupBlocked();
  const queueDir = QueueFile.defaultQueueDir();
  const processCwds = listProcessCwds().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
  );
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const orphanSizes = new Map<string, number | null>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const isWindows = yield* HostProcess.isWindows;
  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            pathKey(terminal.worktreePath) === pathKey(worktreePath)) ||
          pathKey(cwd) === pathKey(worktreePath) ||
          inside(worktreePath, cwd)
        );
      });

  // pnpm imports packages by clone or reflink when its store shares a device
  // with the worktree. Those files have one link but share blocks with the
  // store, so removing them frees almost nothing. A store on another device
  // forces real copies, which still count.
  const sharedPnpmVirtualStore = Effect.fnUntraced(
    function* (root: string) {
      const nodeModules = path.join(root, "node_modules");
      const text = yield* fs.readFileString(path.join(nodeModules, ".modules.yaml"));
      const manifest = yield* decodePnpmModulesManifest(
        yield* Effect.try({
          try: () => parseYaml(text),
          catch: (cause) => new PnpmModulesManifestParseError({ cause }),
        }),
      );
      // An agent can write this manifest, and statting a network path makes
      // Windows sign in to its host with the user's NTLM credentials.
      if (isNetworkPath(manifest.storeDir) || isNetworkPath(manifest.virtualStoreDir ?? "")) {
        return null;
      }
      const virtualStore = path.resolve(nodeModules, manifest.virtualStoreDir ?? ".pnpm");
      const [store, virtual] = yield* Effect.all([
        fs.stat(manifest.storeDir),
        fs.stat(virtualStore),
      ]);
      return store.dev === virtual.dev ? virtualStore : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const measureWorktree = Effect.fn("storageCleanup.measureWorktree")(
    function* (worktreePath: string) {
      const root = yield* fs.realPath(worktreePath);
      const skipped = yield* sharedPnpmVirtualStore(root);
      const pending = [root];
      let entries = 1;
      let bytes = 0;
      while (pending.length > 0) {
        const target = pending.pop()!;
        if (target === skipped) continue;
        // Effect's stat follows links. Probe with readLink first to get lstat
        // semantics, including skipping dangling links and directory links.
        const isLink = yield* fs.readLink(target).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) =>
              error.cause instanceof Error &&
              "code" in error.cause &&
              error.cause.code === "EINVAL",
            () => Effect.succeed(false),
          ),
        );
        if (isLink) continue;
        if ((yield* fs.realPath(target)) !== target) return null;
        const stat = yield* fs.stat(target);
        if (stat.type === "File") {
          // Removing a shared hardlink leaves its blocks allocated.
          if (Option.getOrElse(stat.nlink, () => 1n) !== 1n) continue;
          bytes += Option.match(stat.blocks, {
            onNone: () => Number(stat.size),
            onSome: (blocks) => Number(blocks * 512n),
          });
        } else if (stat.type === "Directory") {
          const names = yield* fs.readDirectory(target);
          entries += names.length;
          if (entries > 2_000_000) return null;
          for (const name of names) {
            const child = path.join(target, name);
            if (!inside(root, child)) return null;
            pending.push(child);
          }
        }
      }
      return bytes;
    },
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => null),
  );

  // Large snapshots take seconds; use the reader worker instead of blocking the event loop.
  // A scoped sweep reads only its projects' threads; turn ends trigger one per project.
  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* (scope: SweepScope) {
    const snapshots = yield* Effect.forEach(
      scope.projectIds === null ? [undefined] : [...scope.projectIds],
      (projectId) =>
        projections
          .getShellSnapshot(projectId === undefined ? undefined : { projectId })
          .pipe(NodeSqliteClient.readOnly),
    );
    const projects = yield* projectStore.listShells();
    const seen = new Set<string>();
    const threads = snapshots
      .flatMap((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads])
      .filter((thread) => !seen.has(thread.id) && seen.add(thread.id) !== undefined);
    return { projects, threads };
  });

  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (pathKey(projectPath) === pathKey(worktreePath) || inside(worktreePath, projectPath))
        return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (pathKey(realPath) === pathKey(worktreePath) || inside(worktreePath, realPath))
        return true;
    }
    return false;
  });

  const reportOrphanWorktrees = Effect.fn("StorageCleanup.reportOrphanWorktrees")(function* (
    roots: ReadonlyArray<string>,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
    entries: StorageCleanupReportEntry[],
    handled: ReadonlySet<string>,
  ) {
    const rows = yield* sql<{ worktreePath: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(NodeSqliteClient.readOnly);
    const referenced = new Set<string>();
    for (const row of rows) {
      const resolved = path.resolve(row.worktreePath);
      referenced.add(pathKey(resolved));
      referenced.add(
        pathKey(yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved))),
      );
    }
    const referencedAncestors = new Set<string>();
    for (let ancestor of referenced) {
      while (roots.some((root) => inside(root, ancestor))) {
        ancestor = pathKey(path.dirname(ancestor));
        referencedAncestors.add(ancestor);
      }
    }
    const projectRoots = (yield* Effect.forEach(
      yield* Effect.filter(projects, (project) =>
        fs.exists(path.resolve(project.workspaceRoot)).pipe(Effect.orElseSucceed(() => true)),
      ),
      (project) => {
        const resolved = path.resolve(project.workspaceRoot);
        return fs.realPath(resolved).pipe(
          Effect.orElseSucceed(() => resolved),
          Effect.map((realPath) => [resolved, realPath]),
        );
      },
    )).flat();
    const inProject = (target: string, managedRoot: string) =>
      projectRoots.some(
        (root) =>
          !inside(root, managedRoot) && (pathKey(root) === pathKey(target) || inside(root, target)),
      );
    const directories = Effect.fnUntraced(function* (parent: string, managedRoot: string) {
      if (inProject(parent, managedRoot)) return [];
      const result: string[] = [];
      for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
        const target = path.join(parent, name);
        if (!inside(parent, target) || inProject(target, managedRoot)) continue;
        const directory = yield* Effect.gen(function* () {
          if (pathKey(yield* fs.realPath(target)) !== pathKey(target)) return false;
          return (yield* fs.stat(target)).type === "Directory";
        }).pipe(Effect.orElseSucceed(() => false));
        if (directory) result.push(target);
      }
      return result;
    });
    // Let the first walk time out and cache unmeasurable folders; later walks share the remaining budget.
    const now = yield* Clock.currentTimeMillis;
    const measurementDeadline = now + 30_000;
    let firstMeasurement = true;
    const reported = new Set<string>();
    const report = Effect.fnUntraced(
      function* (worktreePath: string) {
        const key = pathKey(worktreePath);
        if (
          reported.has(key) ||
          handled.has(key) ||
          referenced.has(key) ||
          referencedAncestors.has(key) ||
          projectRoots.some((root) => pathKey(root) === key || inside(worktreePath, root))
        )
          return;
        const modified = Option.getOrNull((yield* fs.stat(worktreePath)).mtime);
        if (modified !== null && modified.getTime() > now - ORPHAN_WORKTREE_GRACE_MS) return;
        const gitPath = path.join(worktreePath, ".git");
        const linked = (yield* fs.exists(gitPath)) && (yield* fs.stat(gitPath)).type === "File";
        reported.add(key);
        const remaining = measurementDeadline - (yield* Clock.currentTimeMillis);
        if (!orphanSizes.has(key) && (firstMeasurement || remaining > 0)) {
          const measured = yield* measureWorktree(worktreePath).pipe(
            firstMeasurement ? Effect.asSome : Effect.timeoutOption(remaining),
          );
          firstMeasurement = false;
          if (Option.isSome(measured)) orphanSizes.set(key, measured.value);
        }
        const bytes = orphanSizes.get(key) ?? null;
        entries.push({
          kind: "worktree",
          outcome: "kept",
          reason: linked
            ? "No thread uses this worktree"
            : "No thread uses this folder, and it isn't a git worktree",
          path: worktreePath,
          projectPath: null,
          threadId: null,
          threadTitle: null,
          bytes,
          files: null,
        });
      },
      Effect.orElseSucceed(() => undefined),
    );
    // Linked worktrees can sit deeper inside a plain folder, like <repository>/replay/<n>. Ask
    // the projects' Git for them rather than walking folders that may hold large non-git trees.
    let registered: ReadonlyArray<string> | undefined;
    const nestedWorktrees = Effect.fnUntraced(function* (folder: string, managedRoot: string) {
      if (yield* fs.exists(path.join(folder, ".git"))) return [];
      registered ??= (yield* Effect.forEach(new Set(projectRoots), (root) =>
        git.listWorktreePaths(root).pipe(Effect.orElseSucceed((): string[] => [])),
      )).flat();
      // Locked registrations outlive their directory, whose path may since hold something else.
      return yield* Effect.filter(
        registered.filter(
          (worktree) => inside(folder, worktree) && !inProject(worktree, managedRoot),
        ),
        (worktree) =>
          Effect.gen(function* () {
            if (pathKey(yield* fs.realPath(worktree)) !== pathKey(worktree)) return false;
            return (yield* fs.stat(path.join(worktree, ".git"))).type === "File";
          }).pipe(Effect.orElseSucceed(() => false)),
      );
    });
    for (const root of roots) {
      // Worktrees can be <root>/<repository>/<branch> or explicitly <root>/<name>.
      for (const projectDirectory of yield* directories(root, root)) {
        yield* Effect.gen(function* () {
          if (referenced.has(pathKey(projectDirectory))) return;
          const gitPath = path.join(projectDirectory, ".git");
          if (yield* fs.exists(gitPath)) {
            if ((yield* fs.stat(gitPath)).type === "File") yield* report(projectDirectory);
            return;
          }
          for (const worktreePath of yield* directories(projectDirectory, root)) {
            const nested = yield* nestedWorktrees(worktreePath, root);
            for (const target of nested.length > 0 ? nested : [worktreePath]) yield* report(target);
          }
        }).pipe(Effect.orElseSucceed(() => undefined));
      }
    }
    for (const key of orphanSizes.keys()) {
      if (!reported.has(key)) orphanSizes.delete(key);
    }
  });

  // Use two small Git reads: statusDetailsLocal also diffs and counts for every worktree.
  const branchChanged = Effect.fn("StorageCleanup.branchChanged")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    // Return null for missing/non-repository cwd; force untranslated git diagnostics for matching.
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (result.stderr.toLowerCase().includes("not a git repository")) return null;
      return yield* failure(
        result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      );
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    // Detached HEAD exits 1; full refs avoid shortening when a tag shares the branch name.
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    const ref = head.exitCode === 0 ? head.stdout.trim() : "";
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    return (name?.startsWith("(") ? null : name) !== branch;
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
    rules: WorktreeCleanupRules,
  ) {
    const status = yield* git.execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        rules.worktreeKeepWhen === "tracked-changes"
          ? "--untracked-files=no"
          : "--untracked-files=all",
      ],
      maxOutputBytes: 64 * 1024,
    });
    if (status.stdoutTruncated) return "local changes exceed the inspection limit";
    const records = status.stdout.split("\0").filter(Boolean);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
    }
    if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
    if (rules.worktreeKeepWhen !== "any-local-files") return null;
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 64 * 1024,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    const file = ignored.stdout
      .split("\0")
      .find((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
    return file === undefined ? null : `has ignored files (${file})`;
  });

  const submoduleRemoval = Effect.fn("StorageCleanup.submoduleRemoval")(
    function* (cwd: string, rules: WorktreeCleanupRules) {
      const inspect = (args: string[], maxOutputBytes = 64 * 1024) =>
        git.execute({
          operation: "StorageCleanup.submodules",
          cwd,
          args,
          maxOutputBytes,
        });
      const admin = yield* inspect(["rev-parse", "--absolute-git-dir"]);
      if (admin.stdoutTruncated || admin.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const modules = path.join(admin.stdout.replace(/\n$/, ""), "modules");
      const stored = yield* fs.exists(modules);
      if (!stored && !(yield* fs.exists(path.join(cwd, ".gitmodules"))))
        return { force: false, reason: null };
      const populated = yield* inspect([
        "submodule",
        "foreach",
        "--recursive",
        "--quiet",
        'printf "%s\\0" "$toplevel/$sm_path"',
      ]);
      if (populated.stdoutTruncated || populated.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const paths = populated.stdout.split("\0").filter(Boolean);
      const pending = [modules];
      for (const submodule of paths) {
        const directory = yield* inspect(["-C", submodule, "rev-parse", "--absolute-git-dir"]);
        if (directory.stdoutTruncated || directory.stderrTruncated)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        pending.push(directory.stdout.replace(/\n$/, ""));
      }
      const visited = new Set<string>();
      while (pending.length > 0) {
        const directory = pending.pop()!;
        if (!(yield* fs.exists(directory))) continue;
        const canonical = yield* fs.realPath(directory);
        if (visited.has(canonical)) continue;
        visited.add(canonical);
        if (visited.size > 10_000)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        if ((yield* fs.stat(directory)).type !== "Directory")
          return { force: false, reason: "submodule repository could not be inspected" };
        if (yield* fs.exists(path.join(directory, "HEAD"))) {
          const unpushed = yield* inspect([
            "--git-dir",
            directory,
            "--work-tree",
            cwd,
            "rev-list",
            "--max-count=1",
            "HEAD",
            "--all",
            "--reflog",
            "--not",
            "--remotes",
          ]);
          if (unpushed.stdoutTruncated || unpushed.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          if (unpushed.stdout.trim() !== "")
            return { force: false, reason: "submodule has commits not on a remote-tracking ref" };
          pending.push(path.join(directory, "modules"));
        } else {
          for (const name of yield* fs.readDirectory(directory))
            pending.push(path.join(directory, name));
        }
      }
      // Check files after walking stored history to shorten the gap before forced removal.
      for (const submodule of paths) {
        const changes = yield* localChangesReason(submodule, rules);
        if (changes !== null) return { force: false, reason: `submodule ${changes}` };
      }
      const force = stored || paths.length > 0;
      if (force && rules.worktreeKeepWhen !== "tracked-changes") {
        const root = yield* fs.realPath(cwd);
        // Git status and foreach omit files inside deinitialized gitlink directories.
        const populatedPaths = new Set(paths.map(pathKey));
        const unchecked: string[] = [];
        for (const repository of [root, ...paths]) {
          const index = yield* inspect(
            ["-C", repository, "ls-files", "--stage", "-z"],
            16 * 1024 * 1024,
          );
          if (index.stdoutTruncated || index.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          for (const entry of index.stdout.split("\0")) {
            if (!entry.startsWith("160000 ")) continue;
            const submodule = path.resolve(repository, entry.slice(entry.indexOf("\t") + 1));
            if (!inside(root, submodule))
              return { force: false, reason: "submodules could not be inspected" };
            if (!populatedPaths.has(pathKey(submodule)) && (yield* fs.exists(submodule)))
              unchecked.push(submodule);
          }
        }
        let inspected = unchecked.length;
        while (unchecked.length > 0) {
          if (inspected > 10_000)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          const target = unchecked.pop()!;
          if (
            (yield* fs.realPath(target)) !== path.resolve(target) ||
            (yield* fs.stat(target)).type !== "Directory"
          )
            return { force: false, reason: "submodule has local files" };
          if (path.basename(target) === "node_modules") continue;
          const names = yield* fs.readDirectory(target);
          inspected += names.length;
          for (const name of names) unchecked.push(path.join(target, name));
        }
      }
      return { force, reason: null };
    },
    Effect.orElseSucceed(() => ({ force: false, reason: "submodules could not be inspected" })),
  );

  const cleanupGit = Effect.fn("StorageCleanup.cleanupGit")(function* (
    cwd: string,
    args: string[],
    command: string,
  ) {
    const result = yield* git.execute({
      operation: "StorageCleanup.cleanupGit",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0)
      return yield* new GitCommandError({
        operation: "StorageCleanup.cleanupGit",
        command,
        cwd,
        detail: result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      });
  });

  // The newest process list; quiet checks before and inside the workspace lease each take one.
  const processInside = Effect.fnUntraced(function* (worktreePath: string) {
    const cwds = yield* processCwds;
    if (cwds === null) return "running processes could not be checked";
    const real = yield* fs.realPath(worktreePath).pipe(Effect.orElseSucceed(() => worktreePath));
    return cwds.some(
      (cwd) =>
        pathKey(cwd) === pathKey(real) ||
        inside(real, cwd) ||
        pathKey(cwd) === pathKey(worktreePath) ||
        inside(worktreePath, cwd),
    )
      ? "a process is running in it"
      : null;
  });

  /** Why a worktree still looks in use, or null once nothing has touched it for a while. */
  const busyReason = Effect.fnUntraced(function* (
    worktreePath: string,
    adminDir: string | null,
    now: number,
  ) {
    if (hasTerminal(worktreePath)) return "open terminal";
    const sessionRows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_provider_sessions
      WHERE status != 'stopped'
    `.pipe(NodeSqliteClient.readOnly);
    for (const row of sessionRows) {
      const session = yield* decodeCleanupSession(row.payload_json);
      const cwd = path.resolve(session.cwd);
      if (
        (pathKey(cwd) === pathKey(worktreePath) || inside(worktreePath, cwd)) &&
        (yield* providerSessions.isLive(session.id))
      )
        return "provider session is still open";
    }
    const process = yield* processInside(worktreePath);
    if (process !== null) return process;
    if (adminDir !== null) {
      const { activeAt } = yield* worktreeTimes(worktreePath, adminDir);
      if (activeAt !== null && activeAt > now - QUIET_MS) return "used moments ago";
    }
    const file = yield* recentlyChangedFile(git.execute, worktreePath, now - QUIET_MS);
    if (file === "too many files") return "too many files to check for recent changes";
    return file === null ? null : `files changed moments ago (${file})`;
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: StorageCleanupReportEntry[],
    scope: SweepScope,
    decisions: Map<string, Decision>,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled))
      return { waiting: false, kept: [] };
    const full = scope.projectIds === null;
    if (devBlocked) {
      if (full)
        entries.push({
          kind: "worktree",
          outcome: "kept",
          reason: DEV_BLOCKED_REASON,
          path: null,
          projectPath: null,
          threadId: null,
          threadTitle: null,
          bytes: null,
          files: null,
        });
      return { waiting: false, kept: [] };
    }
    let waiting = false;
    const kept: string[] = [];
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(
      serverSettings,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    )) {
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    const realKey = (target: string) =>
      fs.realPath(target).pipe(
        Effect.orElseSucceed(() => path.resolve(target)),
        Effect.map(pathKey),
      );
    const scopeKey = scope.worktreePath === null ? null : yield* realKey(scope.worktreePath);
    const inScope = Effect.fnUntraced(function* (projectId: ProjectId, worktreePath: string) {
      if (scope.projectIds !== null && !scope.projectIds.has(projectId)) return false;
      return scopeKey === null || (yield* realKey(worktreePath)) === scopeKey;
    });
    const decide = (
      worktreePath: string,
      projectId: ProjectId | null,
      outcome: Decision["outcome"],
      code: KeepCode,
      reason: string,
    ) => decisions.set(pathKey(worktreePath), { outcome, code, reason, projectId });
    const worktreePathReason = Effect.fn("StorageCleanup.worktreePathReason")(function* (
      worktreePath: string,
      managedOnly = true,
    ) {
      // Allow symlinked parents, never a symlinked worktree directory.
      const realPath = yield* fs.realPath(worktreePath);
      const realParent = yield* fs.realPath(path.dirname(worktreePath));
      if (realPath !== path.join(realParent, path.basename(worktreePath)))
        return "worktree is a symbolic link";
      if (managedOnly && !roots.some((root) => inside(root, realPath)))
        return "outside the managed worktree folder";
      if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
        return "not a linked worktree";
      return null;
    });

    // The default branch, locally and on the remote: local merges are often not pushed yet.
    const defaultBaseCache = new Map<
      string,
      | { readonly branch: string; readonly remote: string | null; readonly bases: string[] }
      | { readonly reason: string }
    >();
    const defaultBases = Effect.fnUntraced(function* (repositoryCwd: string) {
      const cached = defaultBaseCache.get(repositoryCwd);
      if (cached !== undefined) return cached;
      const remotes = yield* git.execute({
        operation: "StorageCleanup.listRemotes",
        cwd: repositoryCwd,
        args: ["remote"],
      });
      const remote =
        remotes.stdout.trim() === "" ? null : yield* git.resolvePrimaryRemoteName(repositoryCwd);
      let branch: string | null;
      if (remote === null) {
        const projectHead = yield* git.execute({
          operation: "StorageCleanup.resolveProjectBranch",
          cwd: repositoryCwd,
          args: ["symbolic-ref", "--quiet", "HEAD"],
          allowNonZeroExit: true,
        });
        branch =
          projectHead.exitCode === 0 ? projectHead.stdout.trim().slice("refs/heads/".length) : null;
        if (branch === null) {
          const result = { reason: "project branch is unavailable" };
          defaultBaseCache.set(repositoryCwd, result);
          return result;
        }
      } else {
        branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
        // Without a local HEAD ref, only the remote can identify its default;
        // a conventional name may be a feature branch. Scoped sweeps stay offline.
        if (branch === null && full)
          branch = yield* git
            .execute({
              operation: "StorageCleanup.resolveDefaultBranch",
              cwd: repositoryCwd,
              args: ["ls-remote", "--symref", "--", remote, "HEAD"],
              timeoutMs: 20_000,
            })
            .pipe(
              Effect.map(
                (result) => /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(result.stdout)?.[1] ?? null,
              ),
              Effect.orElseSucceed(() => null),
            );
        if (branch !== null && full)
          yield* git
            .fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logDebug("storage cleanup could not refresh the default branch", { error }),
              ),
            );
      }
      const bases: string[] = [];
      if (branch !== null)
        for (const ref of [
          `refs/heads/${branch}`,
          ...(remote === null ? [] : [`refs/remotes/${remote}/${branch}`]),
        ]) {
          const resolved = yield* git.execute({
            operation: "StorageCleanup.resolveDefaultBase",
            cwd: repositoryCwd,
            args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
            allowNonZeroExit: true,
          });
          if (resolved.exitCode === 0 && resolved.stdout.trim() !== "")
            bases.push(resolved.stdout.trim());
        }
      const result =
        branch === null || bases.length === 0
          ? { reason: "default branch is unavailable" }
          : { branch, remote, bases };
      defaultBaseCache.set(repositoryCwd, result);
      return result;
    });

    /** Whether "Delete merged worktrees" removes this worktree now; null keep code means remove. */
    const mergedVerdict = Effect.fnUntraced(function* (input: {
      readonly rules: WorktreeCleanupRules;
      readonly repositoryCwd: string;
      readonly worktreePath: string;
      readonly head: string;
      readonly activityAt: number | null;
      readonly finished: boolean;
      /** The thread's branch, to ask its host whether a pull request merged it. */
      readonly branch: string | null;
    }) {
      const target = yield* defaultBases(input.repositoryCwd);
      if ("reason" in target) return { keep: target.reason, code: "other" as const };
      const integration = yield* integratedInto({
        execute: git.execute,
        cwd: input.worktreePath,
        head: input.head,
        bases: target.bases,
      });
      let via = `merged into ${target.branch}`;
      let integrated = integration.integrated;
      // A pull request merged on the host that later default-branch changes conflict with.
      if (!integrated && full && target.remote !== null && input.branch !== null) {
        const pullRequest = yield* gitManager
          .branchPullRequest({ cwd: input.worktreePath, branch: input.branch }, { refresh: true })
          .pipe(Effect.orElseSucceed(() => null));
        integrated = storageCleanupPullRequestMerged(pullRequest, {
          branch: input.branch,
          defaultBranch: target.branch,
          headSha: input.head,
          integrated: false,
        });
        via = "pull request was merged";
      }
      if (!integrated)
        return !integration.integrated && integration.unknown
          ? {
              keep: `could not check whether its commits are in ${target.branch}`,
              code: "other" as const,
            }
          : { keep: `has commits not in ${target.branch}`, code: "not-integrated" as const };
      if (input.rules.worktreeMerged === "after-days" && !input.finished) {
        const days = input.rules.worktreeMergedAfterDays;
        const idle = input.activityAt === null ? 0 : Math.max(0, now - input.activityAt);
        if (idle < days * DAY_MS)
          return {
            keep: `${via}; inactive for ${Math.floor(idle / DAY_MS)} of ${days} days`,
            code: "not-due" as const,
          };
      }
      return { reason: input.finished ? `${via}; its agent finished with it` : via };
    });

    let projectsForCopies: ReadonlyArray<OrchestrationProjectShell> | undefined;
    /** Removes a worktree that passed every check; shared by thread and threadless worktrees. */
    const removeChecked = Effect.fnUntraced(function* (input: {
      readonly worktreePath: string;
      readonly repositoryCwd: string;
      readonly rules: WorktreeCleanupRules;
      /** The snapshot owner; null skips the snapshot, as for a deleted thread. */
      readonly snapshotKey: string | null;
      /** Merged and threadless removals re-check that nothing uses the worktree. */
      readonly adminDir: string | null | undefined;
      readonly entry: StorageCleanupReportEntry;
      readonly removalReason: string;
      readonly bytes: number | null;
      readonly projectId: ProjectId | null;
      readonly keep: (reason: string, code: KeepCode) => void;
    }) {
      const { worktreePath, rules } = input;
      if (devBlocked) return input.keep(DEV_BLOCKED_REASON, "off");
      if (input.adminDir !== undefined) {
        const busy = yield* busyReason(worktreePath, input.adminDir, now);
        if (busy !== null) return input.keep(busy, "busy");
      }
      const realPath = yield* fs.realPath(worktreePath);
      // Removal discards untracked files; the thread's Restore brings them back from this ref.
      if (input.snapshotKey !== null) {
        const saved = yield* captureWorktreeSnapshot({
          execute: git.execute,
          cwd: worktreePath,
          threadId: input.snapshotKey,
          now,
        }).pipe(Effect.result);
        if (saved._tag === "Failure")
          return input.keep(`snapshot failed: ${cleanupFailureReason(saved.failure)}`, "other");
      }
      // Clean only untracked files. Ordinary worktrees retain Git's final tracked-edit check.
      if (rules.worktreeKeepWhen === "tracked-changes")
        yield* cleanupGit(worktreePath, ["clean", "-ffdx"], "git clean");
      const submodules = yield* submoduleRemoval(worktreePath, rules);
      if (submodules.reason !== null) return input.keep(submodules.reason, "other");
      if (submodules.force) {
        const changes = yield* localChangesReason(worktreePath, rules);
        if (changes !== null) return input.keep(changes, "dirty");
      }
      yield* removeLinkedWorktree({
        operation: "StorageCleanup.cleanupGit",
        cwd: input.repositoryCwd,
        worktreePath,
        // Git requires force for submodules; recursive checks above cannot make removal atomic.
        force: submodules.force,
        execute: git.execute,
        run: (args) => cleanupGit(input.repositoryCwd, [...args], "git worktree remove"),
      });
      entries.push({
        ...input.entry,
        outcome: "removed",
        reason: sentence(input.removalReason),
        bytes: input.bytes,
      });
      decide(worktreePath, input.projectId, "removed", "other", input.removalReason);
      yield* gitManager.invalidateStatus(input.repositoryCwd);
      if (rules.worktreeRunnerCopy) {
        projectsForCopies ??= yield* projectStore.listShells();
        const removal = copyRemovalFor(
          runnerBlockOf(
            serverSettings,
            projectsForCopies.map((project) => ({
              id: project.id,
              workspaceRoot: project.workspaceRoot,
            })),
            { pid: 0, home: config.baseDir, primary: false },
          ),
          realPath,
          now,
        );
        if (removal !== null)
          yield* Effect.try({
            try: () => QueueFile.addCopyRemoval(queueDir, removal),
            catch: (cause) =>
              new HeavyQueueError({ reason: "unavailable", message: String(cause) }),
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("storage cleanup could not queue a Linux copy removal", { error }),
            ),
          );
      }
      yield* Effect.logInfo("storage cleanup removed worktree", { path: worktreePath });
    });

    const deletedRows = yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `.pipe(NodeSqliteClient.readOnly);
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter((thread) => thread.worktreePath !== null && thread.branch !== null);
    const snapshot = yield* readThreads(scope);
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const deletedByPath = Map.groupBy(deletedThreads, (thread) =>
      path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups].map(
        ([worktreePath, group]) =>
          // A deleted thread still owns the worktree its remaining subagents share,
          // but only deletion cleanup acts on it; otherwise the live rules apply.
          deletedByPath
            .get(worktreePath)
            ?.find(
              (deleted) =>
                resolveWorktreeCleanup(serverSettings, deleted.projectId).worktreeOnDelete &&
                worktreeOwner([deleted, ...group]) === deleted,
            ) ??
          worktreeOwner(group) ??
          group[0]!,
      ),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath!))),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = path.resolve(thread.worktreePath!);
      if (!(yield* inScope(thread.projectId, worktreePath))) continue;
      const group = groups.get(worktreePath) ?? [];
      const activityAt = Math.max(...group.map(storageCleanupActivityAt));
      const deleted = "workspaceRoot" in thread;
      // Without deletion cleanup, a deleted thread's worktree is threadless; the pass below takes it.
      if (deleted && !settings.worktreeOnDelete && mergedCleanupEnabled(settings)) continue;
      const settlementChain = deleted
        ? []
        : worktreeSettlementChain(thread, threadsById, now, serverSettings);
      const settledThread = settlementChain.at(-1);
      const members = deleted ? [thread, ...group] : group;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        outcome: "kept",
        reason: "",
        path: worktreePath,
        projectPath: project?.workspaceRoot ?? null,
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      const keep = (reason: string, code: KeepCode = "other") => {
        if (deleted && settings.worktreeOnDelete) kept.push(worktreePath);
        entries.push({ ...entry, reason: sentence(reason) });
        decide(worktreePath, thread.projectId, "kept", code, reason);
      };
      // Reasons a provider session stop or finished deletion work can clear.
      const waitForStop = (reason: string) => {
        if (deleted && settings.worktreeOnDelete) waiting = true;
        return reason;
      };
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(worktreePath))) return;
        if (deleted && !settings.worktreeOnDelete) return keep("no rules apply", "off");
        if (members.length > 1 && worktreeOwner(members) === undefined)
          return keep(`shared by ${members.length} threads`);
        if (project === undefined) return keep("project is unavailable");
        if (
          thread.branch === null ||
          !group.every((member) => storageCleanupThreadIdle(member, now, serverSettings))
        )
          return keep(waitForStop("thread is running or has pending work"), "busy");
        if (group.some((member) => member.branch !== thread.branch))
          return keep("a subagent thread's branch differs from this worktree's branch");
        if (hasTerminal(worktreePath)) return keep(waitForStop("open terminal"), "busy");
        if (
          [...group, ...settlementChain.slice(1)].some(
            (member) =>
              member.settledAt !== null &&
              now - Math.max(DateTime.toEpochMillis(member.updatedAt), activityAt) <
                SETTLE_SCRIPT_GRACE_MS,
          )
        )
          return keep(waitForStop("settled moments ago"), "busy");
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          activityAt < now - settings.worktreeAfterDays * DAY_MS;
        const settledFor =
          settledThread?.settledAt == null
            ? null
            : now - Math.max(DateTime.toEpochMillis(settledThread.settledAt), activityAt);
        const settledDays = settledFor === null ? null : Math.floor(settledFor / DAY_MS);
        const settled =
          settledFor !== null &&
          settings.worktreeSettledAfterDays !== null &&
          settledFor >= settings.worktreeSettledAfterDays * DAY_MS;
        let eligible = deleted || old || settled;
        let removalReason = deleted
          ? "thread was deleted"
          : old
            ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} days`
            : `settled for ${settledDays} days`;
        const notDueReason =
          !deleted && settings.worktreeAfterDays !== null
            ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} of ${settings.worktreeAfterDays} days`
            : settings.worktreeSettledAfterDays !== null
              ? settledFor === null
                ? "not settled"
                : `settled for ${settledDays} of ${settings.worktreeSettledAfterDays} days`
              : "no rules apply";
        // Only the merged rule can make a not-yet-due worktree eligible, so skip Git otherwise.
        if (!eligible && !mergedCleanupEnabled(settings)) return keep(notDueReason, "not-due");
        const pathReason = yield* worktreePathReason(worktreePath);
        if (pathReason !== null) return keep(pathReason);
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects]))
          return keep("contains a project checkout");
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed");
        const changes = yield* localChangesReason(worktreePath, settings);
        if (changes !== null) return keep(changes, "dirty");
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        // Undefined: no quiet check, as for the time-based rules this pass always had.
        let mergedAdminDir: string | null | undefined;
        if (!eligible) {
          const adminDir = yield* worktreeAdminDir(worktreePath);
          const finished = adminDir !== null && (yield* worktreeFinished(adminDir));
          // A worktree made for a thread that has not run yet is still unchanged.
          if (!finished && group.every((member) => member.latestRunId === null))
            return keep("thread has not started", "busy");
          const verdict = yield* mergedVerdict({
            rules: settings,
            repositoryCwd: path.resolve(project.workspaceRoot),
            worktreePath,
            head: head.commitSha,
            activityAt,
            finished,
            branch: thread.branch,
          });
          if ("keep" in verdict) return keep(verdict.keep, verdict.code);
          eligible = true;
          removalReason = verdict.reason;
          mergedAdminDir = adminDir;
          const busy = yield* busyReason(worktreePath, adminDir, now);
          if (busy !== null) return keep(busy, "busy");
        }
        // Re-read this path's threads and sessions so new activity cancels removal; full per-worktree snapshots take seconds.
        const blockedSinceCheck = Effect.fnUntraced(function* () {
          const latestProjects = yield* projectStore.listShells();
          if (yield* containsProjectRoot(worktreePath, [project, ...latestProjects]))
            return "contains a project checkout";
          const latest = (yield* projections.getThreadWorktreePaths({
            includeArchived: true,
          })).filter((entry) => path.resolve(entry.worktreePath) === worktreePath);
          if (hasTerminal(worktreePath)) return waitForStop("open terminal");
          if (deleted) {
            if (
              !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                .worktreeOnDelete
            )
              return "thread or cleanup settings changed since check";
            // Durable deletion cleanup must succeed or be explicitly cancelled before removing its checkout.
            const pendingCleanup = yield* sql<{ status: string }>`
              SELECT status FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled')
            `.pipe(NodeSqliteClient.readOnly);
            // Failed effects never retry, so only running work can finish and free the path.
            if (pendingCleanup.some((row) => row.status !== "failed"))
              return waitForStop("thread deletion is still pending");
            if (pendingCleanup.length > 0) return "thread deletion is still pending";
          }
          const latestShells = yield* Effect.forEach(latest, (entry) =>
            projections.getThreadShell(entry.threadId),
          );
          const latestGroup = latestShells.filter((shell) => shell !== null);
          const latestOwner = worktreeOwner(deleted ? [thread, ...latestGroup] : latestGroup);
          if (
            latestGroup.length !== group.length ||
            latestOwner?.id !== thread.id ||
            latestOwner?.branch !== thread.branch ||
            latestGroup.some((shell) => {
              const previous = group.find((member) => member.id === shell.id);
              return (
                previous === undefined ||
                shell.branch !== thread.branch ||
                !Equal.equals(shell.settledAt, previous.settledAt) ||
                (shell.settledAt !== null && !Equal.equals(shell.updatedAt, previous.updatedAt)) ||
                !storageCleanupThreadIdle(shell, now, serverSettings) ||
                path.resolve(shell.worktreePath!) !== worktreePath ||
                storageCleanupActivityAt(shell) !== storageCleanupActivityAt(previous)
              );
            })
          )
            return waitForStop("thread activity or shared worktree changed since check");
          if (settlementChain.length > 1) {
            const ancestors = yield* Effect.forEach(settlementChain.slice(1), (ancestor) =>
              projections.getThreadShell(ancestor.id),
            );
            const latestSettlement = worktreeSettlementChain(
              latestGroup.find((shell) => shell.id === thread.id)!,
              new Map(
                [...latestGroup, ...ancestors.filter((ancestor) => ancestor !== null)].map(
                  (ancestor) => [ancestor.id, ancestor],
                ),
              ),
              now,
              serverSettings,
            ).at(-1);
            if (
              latestSettlement?.id !== settledThread?.id ||
              !Equal.equals(latestSettlement?.settledAt, settledThread?.settledAt) ||
              !Equal.equals(latestSettlement?.updatedAt, settledThread?.updatedAt)
            )
              return "parent settlement changed since check";
          }
          // Sessions can outlive their run and can be shared across app threads.
          const sessionRows = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_provider_sessions
            WHERE status != 'stopped'
          `.pipe(NodeSqliteClient.readOnly);
          const sessions = yield* Effect.forEach(sessionRows, (row) =>
            decodeCleanupSession(row.payload_json),
          );
          // Ready persisted sessions may have released their runtime; only live sessions protect the path.
          for (const session of sessions) {
            const cwd = path.resolve(session.cwd);
            if (
              (pathKey(cwd) === pathKey(worktreePath) || inside(worktreePath, cwd)) &&
              (yield* providerSessions.isLive(session.id))
            )
              return waitForStop("provider session is still open");
          }
          return null;
        });
        const blocked = yield* blockedSinceCheck();
        if (blocked !== null) return keep(blocked, "busy");
        // Size is an estimate; provider startup must not wait for directory traversal.
        const bytes = yield* measureWorktree(worktreePath);
        yield* withWorkspaceLease(
          worktreePath,
          Effect.gen(function* () {
            const pathReason = yield* worktreePathReason(worktreePath);
            if (pathReason !== null) return keep(pathReason);
            const blockedWhileMeasuring = yield* blockedSinceCheck();
            if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring, "busy");
            if (yield* branchChanged(worktreePath, thread.branch))
              return keep("repository or branch changed since check");
            if (
              (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
              head.commitSha
            )
              return keep("commit changed since check", "busy");
            const finalChanges = yield* localChangesReason(worktreePath, settings);
            if (finalChanges !== null) return keep(finalChanges, "dirty");
            const currentSettings = yield* settingsService.getSettings;
            const current = resolveWorktreeCleanup(currentSettings, thread.projectId);
            if (
              currentSettings.autoResumeLimitedThreads !==
                serverSettings.autoResumeLimitedThreads ||
              currentSettings.snoozeLimitedThreads !== serverSettings.snoozeLimitedThreads ||
              Object.keys(settings).some(
                (key) =>
                  current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
              )
            )
              return keep("settings changed since check");
            yield* removeChecked({
              worktreePath,
              repositoryCwd: project.workspaceRoot,
              rules: settings,
              snapshotKey: deleted ? null : thread.id,
              adminDir: mergedAdminDir,
              entry,
              removalReason,
              bytes,
              projectId: thread.projectId,
              keep,
            });
          }),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              ...entry,
              outcome: "failed",
              reason: cleanupFailureReason(error),
            });
            decide(worktreePath, thread.projectId, "failed", "other", cleanupFailureReason(error));
            if (deleted && settings.worktreeOnDelete) kept.push(worktreePath);
            yield* Effect.logWarning("storage cleanup failed for worktree", {
              threadId: thread.id,
              error,
            });
          }),
        ),
      );
    }

    const handled = new Set<string>();
    /**
     * Every linked worktree of each project's repository that no live thread owns: ones an agent made
     * with `git worktree add`, tool folders like `.claude/worktrees`, and deleted threads' worktrees.
     * The main checkout, locked worktrees and other tools' detached copies outside T3's worktree
     * folders are never touched.
     */
    const cleanThreadless = Effect.fnUntraced(function* () {
      const live = new Set<string>();
      for (const threadPath of groups.keys()) {
        live.add(pathKey(threadPath));
        live.add(
          pathKey(yield* fs.realPath(threadPath).pipe(Effect.orElseSucceed(() => threadPath))),
        );
      }
      // Projects that share one repository share its worktrees.
      const repositories = new Map<string, OrchestrationProjectShell[]>();
      for (const project of snapshot.projects) {
        const common = yield* git
          .execute({
            operation: "StorageCleanup.repositoryOf",
            cwd: project.workspaceRoot,
            args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          })
          .pipe(
            Effect.map((result) => pathKey(result.stdout.trim())),
            Effect.orElseSucceed(() => null),
          );
        if (common === null) continue;
        repositories.set(common, [...(repositories.get(common) ?? []), project]);
      }
      for (const projects of repositories.values()) {
        const projectIds = projects.map((project) => project.id);
        if (scope.projectIds !== null && !projectIds.some((id) => scope.projectIds!.has(id)))
          continue;
        const owner = projects[0]!;
        const listed = yield* listWorktrees(git.execute, owner.workspaceRoot).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (listed === null) continue;
        const main = listed.find((worktree) => worktree.main);
        if (main === undefined) continue;
        const ruleSets = projects.map((project) =>
          resolveWorktreeCleanup(serverSettings, project.id),
        );
        const rules = ruleSets[0]!;
        const sameRules = ruleSets.every((other) => Equal.equals(other, rules));
        for (const worktree of listed) {
          if (worktree.main || worktree.bare || worktree.prunable) continue;
          const worktreePath = path.resolve(worktree.path);
          if (!(yield* inScope(owner.id, worktreePath))) continue;
          const key = pathKey(worktreePath);
          if (live.has(key)) continue;
          const keepSilently = (reason: string, code: KeepCode) =>
            decide(worktreePath, owner.id, "kept", code, reason);
          if (worktree.locked) {
            keepSilently("locked", "other");
            continue;
          }
          if (!(yield* fs.exists(worktreePath))) continue;
          const realPath = yield* fs.realPath(worktreePath).pipe(Effect.orElseSucceed(() => null));
          if (realPath === null) continue;
          if (worktree.branch === null && !roots.some((root) => inside(root, realPath))) {
            keepSilently("a detached checkout outside T3's worktree folders", "other");
            continue;
          }
          if (yield* containsProjectRoot(worktreePath, snapshot.projects)) {
            keepSilently("contains a project checkout", "other");
            continue;
          }
          if (!mergedCleanupEnabled(rules)) {
            keepSilently("cleanup is off for this project", "off");
            continue;
          }
          handled.add(key);
          handled.add(pathKey(realPath));
          const entry: StorageCleanupReportEntry = {
            kind: "worktree",
            outcome: "kept",
            reason: "",
            path: worktreePath,
            projectPath: owner.workspaceRoot,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          };
          const keep = (reason: string, code: KeepCode = "other") => {
            entries.push({ ...entry, reason: sentence(reason) });
            decide(worktreePath, owner.id, "kept", code, reason);
          };
          yield* Effect.gen(function* () {
            if (!sameRules)
              return keep("projects in this repository use different cleanup rules", "other");
            const pathReason = yield* worktreePathReason(worktreePath, false);
            if (pathReason !== null) return keep(pathReason, "other");
            const adminDir = yield* worktreeAdminDir(worktreePath);
            if (adminDir === null) return keep("not a linked worktree", "other");
            const finished = yield* worktreeFinished(adminDir);
            const times = yield* worktreeTimes(worktreePath, adminDir);
            // Its thread may still be on the way: a checkout can be created before its thread row.
            if (
              !finished &&
              (times.createdAt === null || times.createdAt > now - ORPHAN_WORKTREE_GRACE_MS)
            )
              return keep("created moments ago", "busy");
            const changes = yield* localChangesReason(worktreePath, rules);
            if (changes !== null) return keep(changes, "dirty");
            const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
            const verdict = yield* mergedVerdict({
              rules,
              repositoryCwd: main.path,
              worktreePath,
              head: head.commitSha,
              activityAt: times.activeAt,
              finished,
              branch: null,
            });
            if ("keep" in verdict) return keep(verdict.keep, verdict.code);
            const busy = yield* busyReason(worktreePath, adminDir, now);
            if (busy !== null) return keep(busy, "busy");
            const bytes = yield* measureWorktree(worktreePath);
            yield* withWorkspaceLease(
              worktreePath,
              Effect.gen(function* () {
                const latest = (yield* projections.getThreadWorktreePaths({
                  includeArchived: true,
                })).some((owned) => path.resolve(owned.worktreePath) === worktreePath);
                if (latest) return keep("a thread started using it", "busy");
                if (
                  (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
                  head.commitSha
                )
                  return keep("commit changed since check", "busy");
                const finalChanges = yield* localChangesReason(worktreePath, rules);
                if (finalChanges !== null) return keep(finalChanges, "dirty");
                const currentSettings = yield* settingsService.getSettings;
                if (
                  projects.some(
                    (project) =>
                      !Equal.equals(resolveWorktreeCleanup(currentSettings, project.id), rules),
                  )
                )
                  return keep("settings changed since check", "other");
                yield* removeChecked({
                  worktreePath,
                  repositoryCwd: main.path,
                  rules,
                  snapshotKey: `worktree-${path.basename(realPath)}`,
                  adminDir,
                  entry,
                  removalReason: verdict.reason,
                  bytes,
                  projectId: owner.id,
                  keep,
                });
              }),
            );
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                entries.push({ ...entry, outcome: "failed", reason: cleanupFailureReason(error) });
                decide(worktreePath, owner.id, "failed", "other", cleanupFailureReason(error));
                yield* Effect.logWarning("storage cleanup failed for worktree", {
                  path: worktreePath,
                  error,
                });
              }),
            ),
          );
        }
      }
    });
    if (anyWorktreePolicy(serverSettings, mergedCleanupEnabled)) yield* cleanThreadless();
    if (full)
      yield* reportOrphanWorktrees(
        roots,
        yield* projectStore.list({ includeDeleted: true }),
        entries,
        handled,
      );
    return { waiting, kept };
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
    removed: { files: number; bytes: number },
  ) {
    if (days === null || !(yield* fs.exists(root))) return removed;
    // A symlinked parent (a linked T3 home) is fine; a symlinked folder is not.
    const realRoot = yield* fs.realPath(root);
    const realParent = yield* fs.realPath(path.dirname(root));
    if (realRoot !== path.join(realParent, path.basename(root))) return removed;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
            removed.files++;
            removed.bytes += Number(stat.size);
          }
        }
      }
    });
    yield* visit(realRoot);
    return removed;
  });

  const reportRef = yield* SubscriptionRef.make<StorageCleanupReport | null>(null);
  // Only deleted threads' worktrees wait on session stops: any stop while one waits, or a stop inside one kept for another reason.
  // A deletion stays pending until a sweep that started after it finishes.
  let deletedWorktreeWaits = true;
  let keptDeletedWorktrees: ReadonlyArray<string> = [];
  let deletions = 0;
  let sweptDeletions = 0;
  // Worktrees kept only because something still used them; a session stop inside one sweeps its project.
  const waitingOnUse = new Map<string, ProjectId>();
  const noteWaiting = (scope: SweepScope, decisions: ReadonlyMap<string, Decision>) => {
    for (const [key, projectId] of waitingOnUse)
      if (scope.projectIds === null || scope.projectIds.has(projectId)) waitingOnUse.delete(key);
    for (const [key, decision] of decisions)
      if (decision.outcome === "kept" && decision.code === "busy" && decision.projectId !== null)
        waitingOnUse.set(key, decision.projectId);
  };
  const drainCopies = Effect.fn("StorageCleanup.drainCopies")(function* (
    serverSettings: ServerSettings,
  ) {
    if (devBlocked) return;
    const pending = QueueFile.readDoc(queueDir).copyRemovals.length;
    if (pending === 0) return;
    const machine = runnerBlockOf(serverSettings, [], { pid: 0, home: "", primary: false }).machine;
    yield* Effect.tryPromise({
      try: () => drainCopyRemovals(queueDir, machine, process.env),
      catch: (cause) => new HeavyQueueError({ reason: "unavailable", message: String(cause) }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("storage cleanup could not delete Linux copies", { error }),
      ),
    );
  });
  /** Sweeps the projects in scope; worktree decisions only, without the report or file retention. */
  const sweepScope = Effect.fn("StorageCleanup.sweepScope")(function* (scope: SweepScope) {
    const now = yield* Clock.currentTimeMillis;
    const serverSettings = yield* settingsService.getSettings;
    const decisions = new Map<string, Decision>();
    yield* cleanWorktrees(serverSettings, now, [], scope, decisions).pipe(
      Effect.catch((error) =>
        Effect.logWarning("project worktree cleanup failed", { error, scope: scope.projectIds }),
      ),
    );
    noteWaiting(scope, decisions);
    yield* drainCopies(serverSettings);
    return decisions;
  });
  const sweep = Effect.fn("StorageCleanup.sweep")(function* (
    trigger: StorageCleanupReport["trigger"],
  ) {
    const deletionsAtStart = deletions;
    const now = yield* Clock.currentTimeMillis;
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const entries: StorageCleanupReportEntry[] = [];
    const decisions = new Map<string, Decision>();
    const deletedWorktrees = yield* cleanWorktrees(
      serverSettings,
      now,
      entries,
      FULL_SWEEP,
      decisions,
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          entries.push({
            kind: "worktree",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          });
          yield* Effect.logWarning("worktree cleanup failed", { error });
          return { waiting: true, kept: [] };
        }),
      ),
    );
    noteWaiting(FULL_SWEEP, decisions);
    yield* drainCopies(serverSettings);
    // Snapshots live in the developer's real repositories, which dev servers also list.
    if (settings.worktreeSnapshotsAfterDays !== null && !devBlocked) {
      const olderThanMs = now - settings.worktreeSnapshotsAfterDays * DAY_MS;
      for (const project of yield* projectStore
        .list({ includeDeleted: true })
        .pipe(Effect.orElseSucceed(() => []))) {
        yield* pruneWorktreeSnapshots({
          execute: git.execute,
          cwd: project.workspaceRoot,
          olderThanMs,
        }).pipe(
          Effect.catch((error) =>
            Effect.logDebug("worktree snapshot pruning skipped", {
              projectId: project.projectId,
              error,
            }),
          ),
        );
      }
    }
    deletedWorktreeWaits = deletedWorktrees.waiting;
    keptDeletedWorktrees = deletedWorktrees.kept;
    sweptDeletions = deletionsAtStart;
    for (const category of [
      {
        kind: "browser-artifacts" as const,
        root: config.browserArtifactsDir,
        days: settings.browserArtifactsAfterDays,
        label: "browser artifacts",
      },
      {
        kind: "logs" as const,
        root: config.logsDir,
        days: settings.logsAfterDays,
        label: "rotated logs",
      },
    ]) {
      if (category.days === null) continue;
      const removed = { files: 0, bytes: 0 };
      yield* cleanFiles(category.root, category.days, now, category.kind === "logs", removed).pipe(
        Effect.map(({ files, bytes }) =>
          entries.push({
            kind: category.kind,
            outcome: files > 0 ? "removed" : "kept",
            reason: files === 0 ? "No expired files" : `Removed ${files} ${category.label}`,
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: files > 0 ? bytes : null,
            files: files > 0 ? files : null,
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              kind: category.kind,
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: removed.files > 0 ? removed.bytes : null,
              files: removed.files > 0 ? removed.files : null,
            });
            yield* Effect.logWarning("storage file cleanup failed", { kind: category.kind, error });
          }),
        ),
      );
    }
    const counts = { removed: 0, kept: 0, failed: 0 };
    let bytesFreed = 0;
    for (const entry of entries) {
      counts[entry.outcome]++;
      if (entry.outcome !== "kept") bytesFreed += entry.bytes ?? 0;
    }
    const priority = (entry: StorageCleanupReportEntry) =>
      entry.outcome === "failed"
        ? 0
        : entry.outcome === "removed"
          ? 1
          : entry.kind === "worktree" && entry.threadId === null
            ? 2
            : 3;
    const latestReport: StorageCleanupReport = {
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      finishedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries.sort((a, b) => priority(a) - priority(b)).slice(0, REPORT_ENTRY_LIMIT),
      counts,
      bytesFreed,
      omittedCount: Math.max(0, entries.length - REPORT_ENTRY_LIMIT),
    };
    yield* SubscriptionRef.set(reportRef, latestReport);
    return latestReport;
  });
  type SweepJob =
    | { readonly kind: "automatic" }
    | {
        readonly kind: "manual";
        readonly completion: Deferred.Deferred<StorageCleanupReport, ServerSettingsError>;
      }
    | { readonly kind: "projects" }
    | {
        readonly kind: "finish";
        readonly scope: SweepScope;
        readonly completion: Deferred.Deferred<ReadonlyMap<string, Decision>, ServerSettingsError>;
      };
  const automaticSweepQueued = yield* Ref.make(false);
  // Project sweeps coalesce: every request queued before one starts rides on it.
  const pendingProjects = yield* Ref.make<ReadonlySet<ProjectId> | null>(null);
  const runJob = (job: SweepJob) => {
    switch (job.kind) {
      case "automatic":
        return Ref.set(automaticSweepQueued, false).pipe(
          Effect.andThen(sweep("automatic")),
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logWarning("storage cleanup failed", { cause })),
        );
      case "manual":
        return sweep("manual").pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(job.completion, exit)),
          Effect.asVoid,
        );
      case "projects":
        return Ref.getAndSet(pendingProjects, null).pipe(
          Effect.flatMap((projectIds) =>
            projectIds === null
              ? Effect.void
              : sweepScope({ projectIds, worktreePath: null }).pipe(Effect.asVoid),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("project worktree cleanup failed", { cause }),
          ),
        );
      case "finish":
        return sweepScope(job.scope).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(job.completion, exit)),
          Effect.asVoid,
        );
    }
  };
  const worker = yield* makeDrainableWorker(runJob);
  const requestSweep = Ref.getAndSet(automaticSweepQueued, true).pipe(
    Effect.flatMap((queued) => (queued ? Effect.void : worker.enqueue({ kind: "automatic" }))),
  );
  const requestProjectSweep = (projectId: ProjectId) =>
    Ref.modify(pendingProjects, (pending) => [
      pending === null,
      new Set([...(pending ?? []), projectId]),
    ]).pipe(
      Effect.flatMap((first) => (first ? worker.enqueue({ kind: "projects" }) : Effect.void)),
    );
  const runNow = Effect.gen(function* () {
    const completion = yield* Deferred.make<StorageCleanupReport, ServerSettingsError>();
    yield* worker.enqueue({ kind: "manual", completion });
    return yield* Deferred.await(completion);
  });

  const finishWorktree = Effect.fn("StorageCleanup.finishWorktree")(
    function* (input: { readonly threadId: ThreadId; readonly worktreePath?: string | undefined }) {
      const unavailable = (cause: unknown) =>
        new WorktreeFinishError({ reason: "unavailable", cause });
      const thread = yield* projections
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(unavailable));
      if (thread === null) return yield* new WorktreeFinishError({ reason: "thread-not-found" });
      const [project] = yield* projectStore
        .listShells({ projectIds: [thread.projectId] })
        .pipe(Effect.mapError(unavailable));
      if (project === undefined)
        return yield* new WorktreeFinishError({ reason: "project-not-found" });
      const requested = input.worktreePath ?? thread.worktreePath;
      const kept = (
        worktreePath: string,
        reason: WorktreeFinishKeptReason,
        detail: string,
      ): WorktreeMcpFinishResult => ({ status: "kept", worktreePath, reason, detail });
      if (requested === null)
        return kept(
          "",
          "not-a-worktree",
          "This thread has no worktree. Pass `worktreePath` for a worktree you created.",
        );
      if (!path.isAbsolute(requested))
        return kept(requested, "not-a-worktree", "Pass the worktree's absolute path.");
      const rules = resolveWorktreeCleanup(
        yield* settingsService.getSettings.pipe(Effect.mapError(unavailable)),
        project.id,
      );
      if (!mergedCleanupEnabled(rules))
        return kept(
          requested,
          "cleanup-off",
          "Deleting merged worktrees is off for this project, so the worktree stays. The user can turn it on in Settings > Storage.",
        );
      if (devBlocked) return kept(requested, "cleanup-off", `${DEV_BLOCKED_REASON}.`);
      if (!(yield* fs.exists(requested).pipe(Effect.orElseSucceed(() => true))))
        return finishResult(requested, undefined, false);
      const realRequested = yield* fs.realPath(requested).pipe(Effect.mapError(unavailable));
      const listed = yield* listWorktrees(git.execute, project.workspaceRoot).pipe(
        Effect.mapError(unavailable),
      );
      if (listed === null) return yield* unavailable("worktree list was cut off");
      let match: (typeof listed)[number] | undefined;
      for (const worktree of listed) {
        const real = yield* fs
          .realPath(worktree.path)
          .pipe(Effect.orElseSucceed(() => path.resolve(worktree.path)));
        if (pathKey(real) === pathKey(realRequested)) match = worktree;
      }
      if (match === undefined)
        return kept(
          requested,
          "not-a-worktree",
          "It is not a worktree of this project's repository.",
        );
      if (match.main)
        return kept(
          requested,
          "main-checkout",
          "It is the repository's main checkout, which stays.",
        );
      if (match.locked)
        return kept(requested, "locked", "It is locked with `git worktree lock`, so it stays.");
      const adminDir = yield* worktreeAdminDir(match.path).pipe(Effect.mapError(unavailable));
      if (adminDir === null)
        return kept(requested, "not-a-worktree", "It is not a linked worktree.");
      yield* markWorktreeFinished(adminDir, yield* Clock.currentTimeMillis).pipe(
        Effect.mapError(unavailable),
      );
      const completion = yield* Deferred.make<ReadonlyMap<string, Decision>, ServerSettingsError>();
      yield* worker.enqueue({
        kind: "finish",
        scope: { projectIds: new Set([project.id]), worktreePath: match.path },
        completion,
      });
      const decisions = yield* Deferred.await(completion).pipe(Effect.mapError(unavailable));
      const decision =
        decisions.get(pathKey(path.resolve(match.path))) ??
        [...decisions.entries()].find(([key]) => key === pathKey(realRequested))?.[1];
      return finishResult(
        requested,
        decision,
        yield* fs.exists(match.path).pipe(Effect.orElseSucceed(() => true)),
      );
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      requestSweep.pipe(
        Effect.andThen(worker.drain),
        Effect.repeat(Schedule.spaced("1 hour")),
        Effect.asVoid,
      ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return requestSweep;
      }),
    );
    // A turn's end is when an agent typically merges its worktree into the default branch.
    const wakeOnRunEnd = (event: OrchestrationV2DomainEvent) =>
      event.type === "run.updated" &&
      terminalRunStatuses.has(event.payload.status) &&
      anyWorktreePolicy(lastSettings, mergedCleanupEnabled)
        ? projections.getThreadShell(event.threadId).pipe(
            Effect.flatMap((thread) =>
              thread === null ? Effect.void : requestProjectSweep(thread.projectId),
            ),
            Effect.catch((error) =>
              Effect.logDebug("storage cleanup skipped a run-end sweep", { error }),
            ),
          )
        : Effect.void;
    const wakeOnSessionStop = (event: OrchestrationV2DomainEvent) => {
      if (
        event.type !== "provider-session.updated" ||
        (event.payload.status !== "stopped" && event.payload.status !== "error")
      )
        return Effect.void;
      const cwd = pathKey(event.payload.cwd);
      const projects = new Set(
        [...waitingOnUse]
          .filter(([key]) => key === cwd || inside(key, cwd))
          .map(([, projectId]) => projectId),
      );
      return Effect.forEach(projects, requestProjectSweep, { discard: true });
    };
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        const wakes = Effect.andThen(wakeOnRunEnd(event), wakeOnSessionStop(event));
        return Effect.andThen(wakes, deletionWake(event));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
    function deletionWake(event: OrchestrationV2DomainEvent): Effect.Effect<void> {
      if (event.type === "thread.deleted") deletions++;
      else if (
        event.type !== "provider-session.updated" ||
        (event.payload.status !== "stopped" && event.payload.status !== "error")
      )
        return Effect.void;
      else if (!deletedWorktreeWaits && deletions === sweptDeletions) {
        const cwd = pathKey(event.payload.cwd);
        if (
          !keptDeletedWorktrees.some(
            (worktreePath) => pathKey(worktreePath) === cwd || inside(worktreePath, cwd),
          )
        )
          return Effect.void;
      }
      if (!anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)) return Effect.void;
      return event.type === "provider-session.updated" && event.payload.status === "error"
        ? providerSessions
            .isLive(event.payload.id)
            .pipe(Effect.flatMap((live) => (live ? Effect.void : requestSweep)))
        : requestSweep;
    }
  });
  yield* start();
  return StorageCleanup.of({
    runNow,
    latestReport: SubscriptionRef.get(reportRef),
    reports: SubscriptionRef.changes(reportRef),
    drain: worker.drain,
    finishWorktree,
  });
});

export const layer = Layer.effect(StorageCleanup, make);
