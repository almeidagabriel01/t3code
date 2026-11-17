// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The machine-wide heavy-work queue as one JSON file. Plain Node and synchronous: the `t3 heavy`
 * CLI fast path loads it before the Effect runtime, and every T3 server on the machine shares it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  HEAVY_QUEUE_DEFAULTS,
  heavyQueueLimitError,
  HEAVY_QUEUE_LIMITS,
  HeavyQueueError,
  type HeavyQueueEntry,
  type HeavyQueueLimitKey,
  type HeavyQueueRule,
  type HeavyRunner,
  type RunnerProjectConfig,
} from "@t3tools/contracts";

import {
  DEFAULT_MAX_RUNNING,
  hasHeadroom,
  HISTORY_RUNS,
  estimate,
  medianDuration,
  runsOf,
  signatureOf,
  type History,
  type LinuxHistory,
  type Sample,
  SAMPLE_FRESH_MS,
  sustain,
  workersFor,
} from "./admission.ts";
import { sourceCheckout } from "./claudeSettingsHook.ts";
import { COMMIT_RUNS_DIRECT, commitRoute } from "./commitHooks.ts";
import {
  interceptBashCall,
  isQueued,
  lineParts,
  SCRIPT_MAX_BYTES,
  type ReadScript,
} from "./heavyHook.ts";
import {
  deadlineRecord,
  endedRecord,
  type Fault,
  faultRecord,
  type HeavyEventRecord,
  lineOf,
  parseLog,
  requeueRecord,
  startRecord,
  withRecord,
} from "./heavyNotices.ts";
import {
  DEFAULT_MACHINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  eligibilityOf,
  intentOf,
  mayPublish,
  linkAttempts,
  nextHealth,
  planRoutes,
  runnerConfigFor,
  runnerCopyId,
  startFolder,
  UNKNOWN_HEALTH,
  type HealthCheck,
  type LinuxHealth,
  type QueuedEntry,
  type RoutePlan,
  type RunnerBlock,
  type WorkContext,
} from "./runner.ts";

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;
/** A longer silence between readings restarts the steady-headroom window. */
const SAMPLE_GAP_MS = 10_000;

/**
 * Machine-wide on purpose, so it is outside any server's userdata. A T3 running from a checkout
 * gets that checkout's own queue, so it never drives the installed T3's jobs; the env var wins.
 */
export const defaultQueueDir = (
  environment: NodeJS.ProcessEnv = process.env,
  entry: string | undefined = process.argv[1],
) => {
  const checkout = sourceCheckout(entry);
  return (
    environment.T3CODE_HEAVY_QUEUE_DIR?.trim() ||
    (checkout === undefined
      ? NodePath.join(NodeOS.homedir(), ".t3", "heavy-queue")
      : NodePath.join(checkout, ".t3", "heavy-queue-dev"))
  );
};

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const withLock = <A>(dir: string, run: () => A): A => {
  const lock = NodePath.join(dir, "lock");
  NodeFS.mkdirSync(dir, { recursive: true });
  while (true) {
    try {
      NodeFS.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        // ponytail: two contenders can clear the same stale lock and one then deletes the other's fresh lock; holds last milliseconds, so it is rare and the next mutation heals the file.
        if (Date.now() - NodeFS.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          NodeFS.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      pause(LOCK_RETRY_MS);
    }
  }
  try {
    return run();
  } finally {
    NodeFS.rmSync(lock, { recursive: true, force: true });
  }
};

const queuePath = (dir: string) => NodePath.join(dir, "queue.json");

interface QueueDoc {
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  /** False: every waiter starts at once. Absent in older files, which read as on. */
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly rules: ReadonlyArray<HeavyQueueRule>;
  readonly maxRunning: number;
  /** This Mac's finished runs: Linux runs only show the local `remoto` wrapper's usage. */
  readonly history: History;
  /** How long each command took on Linux, newest last; usage there is not measured. */
  readonly linuxHistory: LinuxHistory;
  /** The latest machine reading a server published; waiters cannot measure free memory themselves. */
  readonly sample: Sample | null;
  readonly lastStartAt: number | null;
  readonly holding: boolean;
  /** Minutes without use before T3 shuts an idle simulator or emulator down; 0 never. */
  readonly deviceIdleMinutes: number;
  readonly macMemoryFloorPercent: number;
  readonly macCpuCeilingPercent: number;
  readonly heavyOverLimitSeconds: number;
  readonly lightJobMegabytes: number;
  readonly unseenHeavyMegabytes: number;
  readonly unseenMediumMegabytes: number;
  /** Commands the file remembers runs of; the one run longest ago goes first. */
  readonly historyCommands: number;
  readonly headPatienceMinutes: number;
  /** Runner settings a server published; null reads as the Runner off everywhere. */
  readonly runner: RunnerBlock | null;
  readonly linux: LinuxHealth;
  /** Recently ended jobs' codes, so a repeated request answers the same without running again. */
  readonly results: ReadonlyArray<JobResult>;
  /** Linux copies of removed worktrees still to delete, waiting for the host to come back. */
  readonly copyRemovals: ReadonlyArray<CopyRemoval>;
  /** Linux runs not yet confirmed stopped, kept past their job's end until a heartbeat confirms. */
  readonly lostRuns: ReadonlyArray<LostRun>;
  /** Recent transitions that may need a notice, newest last. */
  readonly events: ReadonlyArray<HeavyEventRecord>;
  /** Daemons outside any job tree that T3 lowered to background CPU priority, to restore later. */
  readonly slowedDaemons: ReadonlyArray<ProcessIdentity>;
}

/** A pid with its start time, so a reused pid never reads as the same process. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly startTimeMs: number;
}

export interface CopyRemoval {
  readonly host: string;
  /** The `runs/<id>` name, already validated by `runnerCopyId`. */
  readonly id: string;
  /** The removed worktree; a checkout recreated there syncs to the same copy again. */
  readonly path: string;
  readonly at: number;
}

/** A run Linux took with it: its job may be gone, but its worktree starts nothing there yet. */
export interface LostRun {
  /** One attempt's record: an entry rerun beside it may leave another for the same folder. */
  readonly key: string;
  readonly entryId: string;
  readonly cwd: string;
  readonly remote: { readonly id: string; readonly pgid: number | null };
  /**
   * A rerun forced onto Linux took its folder: stopped by its own process group only, never by the
   * folder name or the pgid file the rerun rewrites. Until that group is known, the folder waits.
   */
  readonly pgidOnly?: true;
  /** One process stops it at a time: a late stop would also end the next run in that folder. */
  readonly stoppingUntil?: number;
}

interface JobResult {
  readonly id: string;
  readonly code: number;
  readonly at: number;
  /** What it ran, its `--name`, and why it could not start: what someone reading the file needs. */
  readonly line?: string;
  readonly name?: string;
  readonly error?: string;
}
const MAX_RESULTS = 200;
const RESULT_TTL_MS = 3_600_000;

const MAX_COPY_REMOVALS = 200;
const COPY_REMOVAL_TTL_MS = 30 * 86_400_000;

const DEFAULT_DEVICE_IDLE_MINUTES = 20;

const EMPTY_DOC: QueueDoc = {
  entries: [],
  enabled: true,
  paused: false,
  rules: [],
  maxRunning: DEFAULT_MAX_RUNNING,
  history: {},
  linuxHistory: {},
  sample: null,
  lastStartAt: null,
  holding: false,
  deviceIdleMinutes: DEFAULT_DEVICE_IDLE_MINUTES,
  results: [],
  ...HEAVY_QUEUE_DEFAULTS,
  runner: null,
  linux: UNKNOWN_HEALTH,
  copyRemovals: [],
  lostRuns: [],
  events: [],
  slowedDaemons: [],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A stored process group, or null: 0 or 1 is never a run's own, and `kill -- -1` reaches all. */
const realPgid = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : null;

/** A stored queue setting, or its default when it is missing or out of range. */
const limitOf = (parsed: Record<string, unknown> | null, key: HeavyQueueLimitKey) => {
  const value = parsed?.[key];
  return typeof value === "number" && heavyQueueLimitError(key, value) === null
    ? value
    : HEAVY_QUEUE_DEFAULTS[key];
};

/** An older publisher's settings lack newer keys, which read as their defaults. */
const projectConfigOf = (value: unknown) => ({
  ...DEFAULT_PROJECT_CONFIG,
  ...(isObject(value) ? value : {}),
});

/** A block missing any part reads as no block, so a half-written one never routes anything. */
const parseRunner = (value: unknown): RunnerBlock | null =>
  isObject(value) &&
  isObject(value.global) &&
  isObject(value.machine) &&
  Array.isArray(value.projects) &&
  isObject(value.publisher)
    ? ({
        ...value,
        global: projectConfigOf(value.global),
        machine: { ...DEFAULT_MACHINE_CONFIG, ...value.machine },
        projects: (value.projects as unknown[]).map((project) =>
          isObject(project) ? { ...project, config: projectConfigOf(project.config) } : project,
        ),
      } as unknown as RunnerBlock)
    : null;

const loadDoc = (dir: string): QueueDoc => {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(queuePath(dir), "utf8")) as {
      entries?: unknown;
      enabled?: unknown;
      paused?: unknown;
      rules?: unknown;
      maxRunning?: unknown;
      history?: unknown;
      linuxHistory?: unknown;
      sample?: unknown;
      lastStartAt?: unknown;
      holding?: unknown;
      deviceIdleMinutes?: unknown;
      runner?: unknown;
      events?: unknown;
      linux?: unknown;
      copyRemovals?: unknown;
      lostRuns?: unknown;
      slowedDaemons?: unknown;
      results?: unknown;
    } | null;
    const record = isObject(parsed) ? parsed : null;
    return {
      // Keys this version does not know stay in the file for the versions that do.
      ...(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}),
      entries: Array.isArray(parsed?.entries)
        ? (parsed.entries as HeavyQueueEntry[]).map((entry) => {
            if (!isObject(entry.remote) || entry.remote.pgid === undefined) return entry;
            const { pgid, ...remote } = entry.remote;
            const real = realPgid(pgid);
            return { ...entry, remote: real === null ? remote : { ...remote, pgid: real } };
          })
        : [],
      enabled: parsed?.enabled !== false,
      paused: parsed?.paused === true,
      rules: Array.isArray(parsed?.rules) ? (parsed.rules as HeavyQueueRule[]) : [],
      maxRunning:
        typeof parsed?.maxRunning === "number" && parsed.maxRunning >= 1
          ? Math.floor(parsed.maxRunning)
          : DEFAULT_MAX_RUNNING,
      history:
        parsed?.history !== null && typeof parsed?.history === "object"
          ? (parsed.history as History)
          : {},
      linuxHistory: isObject(parsed?.linuxHistory) ? (parsed.linuxHistory as LinuxHistory) : {},
      sample:
        parsed?.sample !== null && typeof parsed?.sample === "object"
          ? (parsed.sample as Sample)
          : null,
      lastStartAt: typeof parsed?.lastStartAt === "number" ? parsed.lastStartAt : null,
      holding: parsed?.holding === true,
      deviceIdleMinutes:
        typeof parsed?.deviceIdleMinutes === "number" && parsed.deviceIdleMinutes >= 0
          ? Math.floor(parsed.deviceIdleMinutes)
          : DEFAULT_DEVICE_IDLE_MINUTES,
      macMemoryFloorPercent: limitOf(record, "macMemoryFloorPercent"),
      macCpuCeilingPercent: limitOf(record, "macCpuCeilingPercent"),
      heavyOverLimitSeconds: limitOf(record, "heavyOverLimitSeconds"),
      lightJobMegabytes: limitOf(record, "lightJobMegabytes"),
      unseenHeavyMegabytes: limitOf(record, "unseenHeavyMegabytes"),
      // A medium job never needs more than a heavy one, whatever an older or edited file says.
      unseenMediumMegabytes: Math.min(
        limitOf(record, "unseenMediumMegabytes"),
        limitOf(record, "unseenHeavyMegabytes"),
      ),
      historyCommands: limitOf(record, "historyCommands"),
      headPatienceMinutes: limitOf(record, "headPatienceMinutes"),
      runner: parseRunner(parsed?.runner),
      linux: isObject(parsed?.linux) ? { ...UNKNOWN_HEALTH, ...parsed.linux } : UNKNOWN_HEALTH,
      copyRemovals: Array.isArray(parsed?.copyRemovals)
        ? (parsed.copyRemovals as unknown[]).filter(
            (entry): entry is CopyRemoval =>
              isObject(entry) &&
              typeof entry.host === "string" &&
              typeof entry.id === "string" &&
              typeof entry.path === "string" &&
              typeof entry.at === "number",
          )
        : [],
      lostRuns: Array.isArray(record?.lostRuns)
        ? record.lostRuns
            .filter(
              (value: unknown): value is LostRun =>
                isObject(value) &&
                typeof value.entryId === "string" &&
                typeof value.cwd === "string" &&
                isObject(value.remote) &&
                typeof value.remote.id === "string",
            )
            .map((lost) => ({
              ...lost,
              key: typeof lost.key === "string" ? lost.key : `${lost.entryId}:${lost.remote.id}`,
              remote: { ...lost.remote, pgid: realPgid(lost.remote.pgid) },
            }))
        : [],
      events: parseLog(parsed?.events),
      results: Array.isArray(record?.results)
        ? record.results.filter(
            (value: unknown): value is JobResult =>
              isObject(value) &&
              typeof value.id === "string" &&
              typeof value.code === "number" &&
              typeof value.at === "number",
          )
        : [],
      slowedDaemons: Array.isArray(record?.slowedDaemons)
        ? record.slowedDaemons.filter(
            (value: unknown): value is ProcessIdentity =>
              isObject(value) &&
              typeof value.pid === "number" &&
              typeof value.startTimeMs === "number",
          )
        : [],
    };
  } catch {
    return EMPTY_DOC;
  }
};

const save = (dir: string, doc: QueueDoc) => {
  const temp = `${queuePath(dir)}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify(doc));
  NodeFS.renameSync(temp, queuePath(dir));
};

const prune = (entries: ReadonlyArray<HeavyQueueEntry>) =>
  entries.filter((entry) => isAlive(entry.pid));

const runningOf = (entries: ReadonlyArray<HeavyQueueEntry>) =>
  entries.filter((entry) => entry.startedAt !== null);

export type StartResult =
  | {
      readonly status: "started";
      /** Null when nothing caps its runners: on Linux, or with the queue off. */
      readonly workers: number | null;
      readonly runner?: "linux";
      readonly ungated?: true;
      /** Why a job bound for Linux starts on this Mac instead, for the agent that waits on it. */
      readonly reason?: string;
    }
  | {
      readonly status: "waiting";
      /** Place among the waiters for its machine, and that machine's first running job. */
      readonly position: number;
      readonly running?: HeavyQueueEntry;
      /** The machine it waits for; absent while no project uses the Runner. */
      readonly runner?: HeavyRunner;
      readonly paused?: true;
      /** Why it is not starting, for people; changes as the machine does. */
      readonly reason?: string;
    }
  | { readonly status: "removed" }
  /** Its question went unanswered and the deadline action is Cancel. */
  | { readonly status: "canceled"; readonly reason: string };

type Decided<A> = { readonly doc: QueueDoc; readonly result: A };

/**
 * `cwd`'s git checkout and, for a worktree, the same folder in the main checkout. Read from
 * `.git` files alone, so the CLI fast path never spawns git.
 */
export const checkoutOf = (cwd: string): { readonly root: string; readonly aliases: string[] } => {
  let dir = cwd;
  while (true) {
    const git = NodePath.join(dir, ".git");
    try {
      const stat = NodeFS.statSync(git);
      if (stat.isDirectory()) return { root: dir, aliases: [] };
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(NodeFS.readFileSync(git, "utf8"))?.[1];
      const main =
        pointer === undefined
          ? null
          : /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(pointer)?.[1];
      return {
        root: dir,
        aliases: main == null ? [] : [NodePath.join(main, NodePath.relative(dir, cwd))],
      };
    } catch {
      const parent = NodePath.dirname(dir);
      if (parent === dir) return { root: cwd, aliases: [] };
      dir = parent;
    }
  }
};

const checkouts = new Map<string, ReturnType<typeof checkoutOf>>();
const cachedCheckout = (cwd: string) => {
  let found = checkouts.get(cwd);
  if (found === undefined) {
    found = checkoutOf(cwd);
    checkouts.set(cwd, found);
  }
  return found;
};

/** The Runner settings that apply to work in `cwd`. */
export const configFor = (doc: Pick<QueueDoc, "runner">, cwd: string): RunnerProjectConfig =>
  runnerConfigFor(doc.runner, cwd, cachedCheckout(cwd).aliases);

/** Queue and Runner switches as they apply to `cwd`, for `heavyRoute`. */
export const modeFor = (doc: Pick<QueueDoc, "enabled" | "runner">, cwd: string) => ({
  enabled: doc.enabled,
  runner: configFor(doc, cwd).runnerEnabled,
});

const gitRoots = new Map<string, string | null>();
/** The git checkout holding `cwd`, or null when none does. */
export const gitRootOf = (cwd: string) => {
  let found = gitRoots.get(cwd);
  if (found === undefined) {
    const { root } = cachedCheckout(cwd);
    found = NodeFS.existsSync(NodePath.join(root, ".git")) ? root : null;
    gitRoots.set(cwd, found);
  }
  return found;
};

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock"];
/** How long an answer is reused: plans run every poll, while .gitignore and lockfiles change rarely. */
const SYNCED_FRESH_MS = 60_000;
const syncedPaths = new Map<string, { readonly at: number; readonly found: boolean }>();

/**
 * Whether `remoto`'s copy of `path`'s checkout has it. It leaves out what git ignores, but
 * reinstalls a `node_modules` from a lockfile between the checkout and it.
 */
export const syncedInCopy = (path: string, now = Date.now()): boolean => {
  const known = syncedPaths.get(path);
  if (known !== undefined && now - known.at < SYNCED_FRESH_MS) return known.found;
  let found: boolean;
  const root = gitRootOf(NodePath.dirname(path));
  const modules = /^(.*?)[\\/]node_modules([\\/]|$)/.exec(path)?.[1];
  if (root === null) found = true;
  else if (modules !== undefined) {
    found = false;
    for (let dir = modules; dir.length >= root.length; dir = NodePath.dirname(dir)) {
      if (LOCKFILES.some((name) => NodeFS.existsSync(NodePath.join(dir, name)))) found = true;
      if (found || dir === root) break;
    }
  } else {
    // Exit 0 is ignored; an error (1 is "not ignored") counts as there.
    const check = NodeChildProcess.spawnSync("git", ["-C", root, "check-ignore", "-q", "--", path]);
    found = check.status !== 0;
  }
  if (syncedPaths.size > 1000) syncedPaths.clear();
  syncedPaths.set(path, { at: now, found });
  return found;
};

const contextOf =
  (doc: QueueDoc) =>
  (cwd: string): WorkContext => ({
    config: configFor(doc, cwd),
    worktree: cachedCheckout(cwd).root,
    home: NodeOS.homedir(),
    rootOf: gitRootOf,
    synced: syncedInCopy,
  });

/** Some project uses the Runner, so jobs can wait on either machine. */
const runnerOn = (doc: QueueDoc) =>
  doc.runner !== null &&
  (doc.runner.global.runnerEnabled ||
    doc.runner.projects.some((project) => project.config.runnerEnabled));

const planOf = (doc: QueueDoc, now: number): RoutePlan =>
  planRoutes({
    entries: doc.entries,
    maxRunning: doc.maxRunning,
    enabled: doc.enabled,
    paused: doc.paused,
    history: doc.history,
    sample: doc.sample,
    lastStartAt: doc.lastStartAt,
    holding: doc.holding,
    macMemoryFloorPercent: doc.macMemoryFloorPercent,
    macCpuCeilingPercent: doc.macCpuCeilingPercent,
    lightJobMegabytes: doc.lightJobMegabytes,
    unseenHeavyMegabytes: doc.unseenHeavyMegabytes,
    unseenMediumMegabytes: doc.unseenMediumMegabytes,
    headPatienceMinutes: doc.headPatienceMinutes,
    now,
    contextOf: contextOf(doc),
    machine: doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG,
    health: doc.linux,
    runnerOn: runnerOn(doc),
    lostCwds: doc.lostRuns.filter(holdsFolder).map((lost) => lost.cwd),
  });

/** Fields that describe one attempt; a requeued entry drops them. */
const withoutAttempt = ({
  startedAt: _startedAt,
  runner: _runner,
  phase: _phase,
  remote: _remote,
  ungated: _ungated,
  workers: _workers,
  requeue: _requeue,
  forced: _forced,
  cpu: _cpu,
  memory: _memory,
  ...rest
}: HeavyQueueEntry) => ({ ...rest, startedAt: null });

/** Starts `id` when the admission plan picks it; running entries stay in front, so index order is wait order. */
const decideStart = (doc: QueueDoc, id: string, now: number): Decided<StartResult> => {
  const { entries } = doc;
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return { doc, result: { status: "removed" } };
  const { sample } = doc;
  const cpuCount = sample?.cpuCount ?? NodeOS.availableParallelism();
  const entry = entries[index]!;
  if (entry.startedAt !== null) {
    return {
      doc,
      result: {
        status: "started",
        workers:
          entry.runner === "linux" || entry.ungated === true
            ? null
            : (entry.workers ?? workersFor(cpuCount, null)),
        ...(entry.runner === "linux" ? { runner: "linux" as const } : {}),
        ...(entry.ungated === true ? { ungated: true as const } : {}),
      },
    };
  }
  const decision = planOf(doc, now);
  const active = runningOf(entries);
  const canceled = decision.cancels[id];
  if (canceled !== undefined) {
    return {
      doc: {
        ...doc,
        entries: entries.filter((e) => e.id !== id),
        // Tell the agent cancels with no question: the requeue already logged the loss.
        events: withRecord(doc.events, entry.ask === undefined ? null : deadlineRecord(entry, now)),
      },
      result: { status: "canceled", reason: canceled },
    };
  }
  const admit = decision.admits[id];
  if (admit !== undefined) {
    const gated = admit.runner === "mac" && !admit.ungated;
    const fresh = sample !== null && now - sample.at <= SAMPLE_FRESH_MS;
    const workers = gated ? workersFor(cpuCount, fresh ? sample.busyCores : null) : null;
    const {
      ask,
      route,
      dropped: _dropped,
      failure: _failure,
      linuxFailedAt: _failed,
      unconfirmed: _unconfirmed,
      ...rest
    }: QueuedEntry = entry;
    const record = startRecord(
      entry,
      intentOf(entry, contextOf(doc)(entry.cwd)).intent,
      admit.runner,
      now,
    );
    const displacedWhy = record?.kind === "displaced" ? decision.reasons[id] : undefined;
    const started: HeavyQueueEntry = {
      ...rest,
      startedAt: new Date(now).toISOString(),
      ...(workers === null ? {} : { workers }),
      ...(admit.runner === "linux" ? { runner: "linux" as const } : {}),
      ...(admit.ungated ? { ungated: true } : {}),
      ...(admit.runner === "linux" && (ask !== undefined || route !== undefined)
        ? {
            held: {
              ...(ask === undefined ? {} : { ask }),
              ...(route === undefined ? {} : { route }),
            },
          }
        : {}),
    };
    return {
      doc: {
        ...doc,
        entries: [
          ...active,
          started,
          ...entries.filter((e) => e.startedAt === null && e.id !== id),
        ],
        // Only a gated Mac start makes the next Mac waiter let it ramp up.
        lastStartAt: gated ? now : doc.lastStartAt,
        holding: decision.holding,
        events: withRecord(doc.events, record),
      },
      result: {
        status: "started",
        workers,
        ...(admit.runner === "linux" ? { runner: "linux" as const } : {}),
        ...(admit.ungated ? { ungated: true as const } : {}),
        ...(displacedWhy === undefined ? {} : { reason: displacedWhy }),
      },
    };
  }
  const ask = decision.asks[id];
  const asked =
    ask === undefined
      ? entries
      : entries.map((e) =>
          e.id === id
            ? {
                ...e,
                ask: {
                  reason: ask,
                  deadlineAt: new Date(
                    now + configFor(doc, e.cwd).runnerAskMinutes * 60_000,
                  ).toISOString(),
                },
              }
            : e,
        );
  // Counted on the machine it waits for, as the Resource Manager groups rows.
  const runner = decision.routes[id] ?? "mac";
  const machineOf = (e: HeavyQueueEntry) =>
    e.startedAt === null ? (decision.routes[e.id] ?? "mac") : (e.runner ?? "mac");
  const there = entries.filter((e) => machineOf(e) === runner);
  const runningThere = there.find((e) => e.startedAt !== null);
  return {
    doc: { ...doc, entries: asked, holding: decision.holding },
    result: {
      status: "waiting",
      position: there.filter((e) => e.startedAt === null).findIndex((e) => e.id === id) + 1,
      ...(runningThere === undefined ? {} : { running: runningThere }),
      ...(runnerOn(doc) ? { runner } : {}),
      ...(doc.enabled && doc.paused ? { paused: true as const } : {}),
      ...(decision.reasons[id] === undefined ? {} : { reason: decision.reasons[id] }),
    },
  };
};

export type MoveResult = "ok" | "not-found" | "running" | "not-allowed" | "unconfirmed";

const trimRoot = (root: string) => root.replace(/[\\/]+$/, "");

/** The most specific rule whose folder contains `cwd` wins. */
const priorityOf = (
  rules: ReadonlyArray<HeavyQueueRule>,
  cwd: string,
): "first" | "normal" | "last" => {
  let best: HeavyQueueRule | undefined;
  for (const rule of rules) {
    const root = trimRoot(rule.root);
    const inside = cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
    if (inside && (best === undefined || root.length > trimRoot(best.root).length)) best = rule;
  }
  return best?.priority ?? "normal";
};

/** The user's own jobs and ones asked to run high go first; the project's rule places the rest. */
const laneOf = (rules: ReadonlyArray<HeavyQueueRule>, entry: HeavyQueueEntry) =>
  entry.priority === "high" || entry.priority === "normal" ? "first" : priorityOf(rules, entry.cwd);

/** Where a new entry goes: ahead of normal waiters for "first", behind them for "last". */
const insertNew = (doc: QueueDoc, entry: HeavyQueueEntry): QueueDoc => {
  const { entries, rules } = doc;
  const lane = laneOf(rules, entry);
  // A manually moved waiter keeps its place against newly arrived entries of any priority.
  const ahead = (e: HeavyQueueEntry) =>
    e.startedAt !== null || e.pinned === true || laneOf(rules, e) === "first";
  const behind = (e: HeavyQueueEntry) =>
    e.startedAt === null && e.pinned !== true && laneOf(rules, e) === "last";
  let at = entries.length;
  if (lane === "first") {
    at = 0;
    while (at < entries.length && ahead(entries[at]!)) at += 1;
  } else if (lane === "normal") {
    while (at > 0 && behind(entries[at - 1]!)) at -= 1;
  }
  return { ...doc, entries: [...entries.slice(0, at), entry, ...entries.slice(at)] };
};

/** Puts waiter `id` before waiter `beforeId`, or last when null; the running entry never moves or gets passed. */
const decideMove = (
  doc: QueueDoc,
  id: string,
  beforeId: string | null,
  note: string | undefined,
): Decided<MoveResult> => {
  const { entries } = doc;
  const target = entries.find((entry) => entry.id === id);
  const anchor = beforeId === null ? undefined : entries.find((entry) => entry.id === beforeId);
  if (target === undefined || (beforeId !== null && anchor === undefined)) {
    return { doc, result: "not-found" };
  }
  if (target.startedAt !== null || (anchor !== undefined && anchor.startedAt !== null)) {
    return { doc, result: "running" };
  }
  if (beforeId === id) return { doc, result: "ok" };
  const rest = entries.filter((entry) => entry.id !== id);
  const at = beforeId === null ? rest.length : rest.findIndex((entry) => entry.id === beforeId);
  const moved = { ...target, pinned: true as const, ...(note === undefined ? {} : { note }) };
  return {
    doc: { ...doc, entries: [...rest.slice(0, at), moved, ...rest.slice(at)] },
    result: "ok",
  };
};

const decideCancel = (doc: QueueDoc, id: string): Decided<MoveResult> => {
  const target = doc.entries.find((entry) => entry.id === id);
  if (target === undefined) return { doc, result: "not-found" };
  if (target.startedAt === null) {
    return {
      doc: { ...doc, entries: doc.entries.filter((entry) => entry.id !== id) },
      result: "ok",
    };
  }
  // A server holding the slot shares its pid with T3 itself; only a `t3 heavy` waiter can be stopped by signal.
  if (target.server === true || target.pid === process.pid || target.pid <= 1) {
    return { doc, result: "running" };
  }
  try {
    process.kill(target.pid, "SIGTERM");
  } catch {
    // Already gone: the next prune frees the slot.
  }
  return { doc, result: "ok" };
};

/** A history to write into: no prototype, so any signature (`__proto__` too) is a plain key. */
const writable = <A>(book: Readonly<Record<string, A>>): Record<string, A> =>
  Object.assign(Object.create(null) as Record<string, A>, book);

/** Keeps at most `commands` commands; the one run longest ago goes first. */
const remember = <A>(
  book: Record<string, ReadonlyArray<A>>,
  signature: string,
  run: A,
  commands: number,
) => {
  const runs = [...(Object.hasOwn(book, signature) ? book[signature]! : []), run].slice(
    -HISTORY_RUNS,
  );
  delete book[signature];
  book[signature] = runs;
  for (const old of Object.keys(book).slice(0, -commands)) delete book[old];
};

/** Each machine learns only from its own runs, so Linux never skews what the Mac admits. */
const withFinishedRuns = (before: QueueDoc, after: QueueDoc, now: number): QueueDoc => {
  const kept = new Set(after.entries.map((entry) => entry.id));
  const history = writable(after.history);
  const linuxHistory = writable(after.linuxHistory);
  let changed = false;
  for (const gone of before.entries) {
    if (gone.startedAt === null || kept.has(gone.id)) continue;
    const signature = signatureOf(gone.label);
    const durationMs = Math.max(0, now - Date.parse(gone.startedAt));
    if (gone.runner === "linux") {
      // A run that never got past syncing says nothing about how long the command takes.
      if (gone.phase !== "running") continue;
      remember(linuxHistory, signature, { durationMs }, after.historyCommands);
    } else {
      if (gone.peakMemory === undefined) continue;
      const run = {
        ...(gone.peakCpu === undefined ? {} : { cpu: gone.peakCpu }),
        memoryBytes: gone.peakMemory,
        durationMs,
      };
      remember(history, signature, run, after.historyCommands);
    }
    changed = true;
  }
  return changed ? { ...after, history, linuxHistory } : after;
};

/** How long `entry`'s command usually takes on `runner`, from that machine's runs; null without any. */
export const usualMs = (
  doc: Pick<QueueDoc, "history" | "linuxHistory">,
  entry: Pick<HeavyQueueEntry, "label">,
  runner: HeavyRunner,
) => medianDuration(runsOf(runner === "linux" ? doc.linuxHistory : doc.history, entry));

const mutate = <A>(dir: string, decide: (doc: QueueDoc) => Decided<A>, now = Date.now()) =>
  withLock(dir, () => {
    const loaded = loadDoc(dir);
    const decided = decide({ ...loaded, entries: prune(loaded.entries) });
    save(dir, withFinishedRuns(loaded, decided.doc, now));
    return decided.result;
  });

/** Pruned view; never writes, tolerates a missing or corrupt file. */
export const readDoc = (dir: string): QueueDoc => {
  const doc = loadDoc(dir);
  return { ...doc, entries: prune(doc.entries) };
};

export const read = (dir: string): ReadonlyArray<HeavyQueueEntry> => readDoc(dir).entries;

/**
 * Adds `entry`, or, for an id already known, attaches to its job: still waiting or running, or
 * ended recently with the code it returns again.
 */
export const enqueue = (dir: string, entry: QueuedEntry, now = Date.now()) =>
  mutate(
    dir,
    (doc): Decided<"added" | "attached" | { readonly code: number }> => {
      if (doc.entries.some((each) => each.id === entry.id)) return { doc, result: "attached" };
      const ended = doc.results.find(
        (each) => each.id === entry.id && now - each.at < RESULT_TTL_MS,
      );
      if (ended !== undefined) return { doc, result: { code: ended.code } };
      return { doc: insertNew(doc, entry), result: "added" };
    },
    now,
  );

export const tryStart = (dir: string, id: string, now = Date.now()) =>
  mutate(dir, (doc) => decideStart(doc, id, now), now);

/** What the admission rules say right now, without starting anyone. */
export const readPlan = (dir: string, now = Date.now()) => {
  const doc = readDoc(dir);
  return { doc, plan: planOf(doc, now) };
};

export const HANDED_OFF_RUNS_DIRECT =
  "Its heavy work already goes through t3 heavy or remoto: runs directly";

/**
 * Where `line`, started now from `cwd`, would run and whether it would start at once: the plan a
 * real job gets, with nothing queued. `linuxFull`: Linux is offline, over its limits, or its jobs
 * and waiters ahead fill its slots.
 */
export const probe = (dir: string, line: string, cwd: string, now = Date.now()) => {
  const doc = readDoc(dir);
  const parts = lineParts(line);
  const at = startFolder(parts.dirs, cwd, NodeOS.homedir());
  const commit = commitRoute(parts.command, at);
  const handedOff = !parts.remoto && isQueued(parts.command, scriptReader(at));
  if (commit === "direct" || handedOff) {
    return {
      runsOn: "direct" as const,
      reason: handedOff ? HANDED_OFF_RUNS_DIRECT : COMMIT_RUNS_DIRECT,
      startsNow: true,
      linuxFull: false,
    };
  }
  const id = `probe-${now}`;
  const withProbe = insertNew(doc, {
    id,
    pid: process.pid,
    threadId: null,
    label: parts.command,
    cwd: at,
    createdAt: new Date(now).toISOString(),
    startedAt: null,
    // As `t3 heavy` queues an agent's job, behind the user's own; a hooked commit goes first.
    priority: commit === "first" ? "high" : "low",
    ...(parts.remoto ? { where: "linux" as const } : {}),
  });
  const plan = planOf(withProbe, now);
  const slots = (doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG).runnerLinuxSlots;
  // Running there or waiting for it ahead of this command: what fills Linux before it.
  const ahead = withProbe.entries
    .slice(
      0,
      withProbe.entries.findIndex((e) => e.id === id),
    )
    .filter((e) => (e.startedAt === null ? plan.routes[e.id] : e.runner) === "linux").length;
  return {
    runsOn: plan.routes[id] ?? ("mac" as const),
    reason: plan.reasons[id] ?? null,
    startsNow: plan.admits[id] !== undefined,
    linuxFull: doc.linux.online === false || doc.linux.overLimit || ahead >= slots,
  };
};

/** A server publishes the machine reading and each running job's process-tree peak. */
export const recordSample = (
  dir: string,
  reading: Omit<Sample, "headroomSince">,
  peaks: Readonly<
    Record<
      string,
      {
        /** Null when the job's processes could not be read: unknown, never 0. */
        readonly cpu: number | null;
        readonly memoryBytes: number;
        readonly daemons?: ReadonlyArray<number>;
      }
    >
  > | null,
) =>
  mutate(dir, (doc) => {
    const continuous = doc.sample !== null && reading.at - doc.sample.at < SAMPLE_GAP_MS;
    const limit = sustain(
      continuous ? doc.sample : null,
      !hasHeadroom(reading, doc),
      reading.at,
      doc.heavyOverLimitSeconds * 1000,
    );
    const entries = doc.entries.map((entry): HeavyQueueEntry => {
      // On Linux the local tree is only `remoto`'s wrapper, not the job. Null: processes not read.
      if (peaks === null || entry.startedAt === null || entry.runner === "linux") return entry;
      const peak = peaks[entry.id];
      const { daemons: _daemons, cpu: _cpu, memory: _memory, ...rest } = entry;
      // A job this sample could not read keeps its peaks but shows no current usage.
      if (peak === undefined) return rest;
      return {
        ...rest,
        ...(peak.daemons === undefined ? {} : { daemons: peak.daemons }),
        ...(peak.cpu === null
          ? {}
          : { cpu: peak.cpu, peakCpu: Math.max(entry.peakCpu ?? 0, peak.cpu) }),
        memory: peak.memoryBytes,
        peakMemory: Math.max(entry.peakMemory ?? 0, peak.memoryBytes),
      };
    });
    // A slowed job takes back what it uses at full speed, so restoring waits for room for that.
    const comeback = entries
      .filter((entry) => entry.slowed === true)
      .reduce((sum, entry) => {
        const full = Math.max(
          entry.peakCpu ?? 0,
          estimate(doc.history, entry, reading.cpuCount, doc).cpu,
        );
        // An unread job counts as using nothing now, so restoring waits rather than flaps.
        return sum + Math.max(0, full - (entry.cpu ?? 0));
      }, 0);
    const slow = sustain(
      continuous ? (doc.sample?.slow ?? null) : null,
      reading.busyCores + comeback > (doc.macCpuCeilingPercent / 100) * reading.cpuCount,
      reading.at,
      doc.heavyOverLimitSeconds * 1000,
    );
    // Admission's short headroom check uses the same unbroken run of readings under the limits.
    const sample: Sample = { ...reading, ...limit, headroomSince: limit.underLimitSince, slow };
    const next: QueueDoc = { ...doc, sample, entries };
    return { doc: next, result: next };
  });

/** Records a slowdown step the sampler applied: entries slowed or restored, daemons held lowered. */
export const recordSlowdown = (
  dir: string,
  step: {
    readonly slowed: ReadonlyArray<string>;
    readonly restored: ReadonlyArray<string>;
    readonly slowedDaemons: ReadonlyArray<ProcessIdentity>;
  },
) =>
  mutate(dir, (doc) => ({
    doc: {
      ...doc,
      slowedDaemons: step.slowedDaemons,
      entries: doc.entries.map((entry) => {
        if (step.slowed.includes(entry.id) && entry.startedAt !== null) {
          return { ...entry, slowed: true, qos: "background" as const };
        }
        if (!step.restored.includes(entry.id)) return entry;
        const { slowed: _slowed, ...rest } = entry;
        return { ...rest, qos: "normal" as const };
      }),
    },
    result: undefined,
  }));

/** Waiter-side election: the first caller under the lock to find the reading stale becomes the sampler. */
export const recordSampleIfStale = (
  dir: string,
  reading: Omit<Sample, "headroomSince">,
  staleMs: number,
) => {
  const current = readDoc(dir).sample;
  if (current !== null && reading.at - current.at < staleMs) return false;
  recordSample(dir, reading, null);
  return true;
};

export const setMaxRunning = (dir: string, maxRunning: number) =>
  mutate(dir, (doc) => ({
    doc: { ...doc, maxRunning: Math.max(1, Math.floor(maxRunning)) },
    result: undefined,
  }));

export const remove = (dir: string, id: string) =>
  mutate(dir, (doc) => ({
    doc: { ...doc, entries: doc.entries.filter((entry) => entry.id !== id) },
    result: undefined,
  }));

/** A `t3 heavy` job's process exiting with `code`: frees its entry and logs a failure. */
export const finish = (
  dir: string,
  id: string,
  code: number,
  now = Date.now(),
  error?: string,
  decided?: string,
) =>
  mutate(
    dir,
    (doc) => {
      const entry: (HeavyQueueEntry & { readonly line?: string }) | undefined = doc.entries.find(
        (each) => each.id === id,
      );
      const line = entry === undefined ? undefined : lineOf(entry);
      // Checked on this Mac: a 127 from a run that reached Linux is Linux's to explain.
      // `decided` was established for both machines, so it stands either way.
      const reason =
        decided ?? (entry?.runner !== "linux" || entry.phase === undefined ? error : undefined);
      const result: JobResult = {
        id,
        code,
        at: now,
        ...(line === undefined ? {} : { line }),
        ...(entry?.name === undefined ? {} : { name: entry.name }),
        ...(reason === undefined ? {} : { error: reason }),
      };
      return {
        doc: {
          ...doc,
          entries: doc.entries.filter((each) => each.id !== id),
          results: [
            ...doc.results.filter((each) => each.id !== id && now - each.at < RESULT_TTL_MS),
            result,
          ].slice(-MAX_RESULTS),
          events: withRecord(doc.events, endedRecord(entry, code, now, reason)),
        },
        result: undefined,
      };
    },
    now,
  );

/** Logs a Linux environment failure of a job still in the queue, for the problem detector to file. */
export const recordFault = (dir: string, id: string, fault: Fault, now = Date.now()) =>
  mutate(
    dir,
    (doc) => {
      const entry = doc.entries.find((each) => each.id === id);
      return {
        doc:
          entry === undefined
            ? doc
            : { ...doc, events: withRecord(doc.events, faultRecord(entry, fault, now)) },
        result: undefined,
      };
    },
    now,
  );

export const move = (dir: string, id: string, beforeId: string | null, note?: string) =>
  mutate(dir, (doc) => decideMove(doc, id, beforeId, note));

/** Moves a waiter to the front of the waiters, right behind the running entry. */
export const promote = (dir: string, id: string, note?: string) =>
  mutate(dir, (doc) =>
    decideMove(doc, id, doc.entries.find((entry) => entry.startedAt === null)?.id ?? id, note),
  );

/** The user override: the waiter starts at once, past the pause, the slots and the load check. */
export const startNow = (dir: string, id: string) =>
  mutate(dir, (doc): Decided<MoveResult> => {
    const target = doc.entries.find((entry) => entry.id === id);
    if (target === undefined) return { doc, result: "not-found" };
    if (target.startedAt !== null) return { doc, result: "running" };
    return {
      doc: {
        ...doc,
        entries: doc.entries.map((entry) => (entry.id === id ? { ...entry, forced: true } : entry)),
      },
      result: "ok",
    };
  });

/**
 * "high" on a waiter releases it at once, like `startNow`; "low" takes that back. A running job's
 * place no longer matters: the caller changes its processes' QoS and records it with `setQos`.
 */
export const setPriority = (dir: string, id: string, priority: "low" | "high") =>
  mutate(dir, (doc): Decided<{ readonly result: MoveResult; readonly entry?: HeavyQueueEntry }> => {
    const target = doc.entries.find((entry) => entry.id === id);
    if (target === undefined) return { doc, result: { result: "not-found" } };
    if (target.startedAt !== null) {
      // The user's choice for a running job stands: T3 stops slowing or restoring it on its own.
      const { slowed: _slowed, ...rest } = target;
      const running: HeavyQueueEntry = { ...rest, priority };
      return {
        doc: { ...doc, entries: doc.entries.map((entry) => (entry.id === id ? running : entry)) },
        result: { result: "ok", entry: running },
      };
    }
    const { forced: _forced, ...rest } = target;
    const updated: HeavyQueueEntry = {
      ...rest,
      priority,
      ...(priority === "high" ? { forced: true } : {}),
    };
    return {
      doc: { ...doc, entries: doc.entries.map((entry) => (entry.id === id ? updated : entry)) },
      result: { result: "ok", entry: updated },
    };
  });

/** Records the CPU QoS a running job's processes were just given. */
export const setQos = (dir: string, id: string, qos: NonNullable<HeavyQueueEntry["qos"]>) =>
  mutate(dir, (doc) => ({
    doc: {
      ...doc,
      entries: doc.entries.map((entry) =>
        entry.id === id && entry.startedAt !== null ? { ...entry, qos } : entry,
      ),
    },
    result: undefined,
  }));

/** Removes a waiter, or stops the running `t3 heavy` command with SIGTERM. */
export const cancel = (dir: string, id: string) => mutate(dir, (doc) => decideCancel(doc, id));

export const setPaused = (dir: string, paused: boolean) =>
  mutate(dir, (doc) => ({ doc: { ...doc, paused }, result: undefined }));

/** Off starts every waiter on its next poll; back on, running entries stay and new ones wait as usual. */
export const setEnabled = (dir: string, enabled: boolean) =>
  mutate(dir, (doc) => ({ doc: { ...doc, enabled }, result: undefined }));

/**
 * Stores the queue settings given in one write, each clamped to its range; other keys are ignored.
 * Throws, writing nothing, when the result would guess a medium job above a heavy one.
 */
export const setLimits = (
  dir: string,
  limits: Readonly<Partial<Record<HeavyQueueLimitKey, number>>>,
) =>
  mutate(dir, (doc) => {
    const set: Partial<Record<HeavyQueueLimitKey, number>> = {};
    for (const key of Object.keys(HEAVY_QUEUE_LIMITS) as ReadonlyArray<HeavyQueueLimitKey>) {
      const value = limits[key];
      if (value === undefined) continue;
      const { min, max } = HEAVY_QUEUE_LIMITS[key];
      set[key] = Math.max(min, Math.min(max, Math.floor(value)));
    }
    const next = { ...doc, ...set };
    if (next.unseenMediumMegabytes > next.unseenHeavyMegabytes) {
      throw new HeavyQueueError({
        reason: "not-allowed",
        message: `A medium job's memory guess can't be more than a heavy job's (${next.unseenHeavyMegabytes} MB).`,
      });
    }
    return { doc: next, result: undefined };
  });

export const setLimit = (dir: string, key: HeavyQueueLimitKey, value: number) =>
  setLimits(dir, { [key]: value });

export const setDeviceIdleMinutes = (dir: string, minutes: number) =>
  mutate(dir, (doc) => ({
    doc: { ...doc, deviceIdleMinutes: Math.max(0, Math.min(24 * 60, Math.floor(minutes))) },
    result: undefined,
  }));

/** `priority` null clears the rule. */
export const setRule = (dir: string, root: string, priority: HeavyQueueRule["priority"] | null) =>
  mutate(dir, (doc) => {
    const kept = doc.rules.filter((rule) => trimRoot(rule.root) !== trimRoot(root));
    return {
      doc: {
        ...doc,
        rules: priority === null ? kept : [...kept, { root: trimRoot(root), priority }],
      },
      result: undefined,
    };
  });

/** Exclusive work, its project's Mac-only list and projects with the Runner off never leave this Mac. */
export const staysOnMac = (doc: QueueDoc, entry: HeavyQueueEntry) => {
  const context = contextOf(doc)(entry.cwd);
  if (!context.config.runnerEnabled) return true;
  const { eligibility } = eligibilityOf(entry, context);
  return eligibility === "exclusive" || eligibility === "mac-only";
};

/** Writes this server's Runner settings unless a live, higher-ranked publisher owns the block. */
export const publishRunner = (dir: string, block: RunnerBlock) =>
  mutate(dir, (doc) =>
    mayPublish(doc.runner, block.publisher, isAlive)
      ? { doc: { ...doc, runner: block }, result: true }
      : { doc, result: false },
  );

/** Folds one heartbeat into Linux health, offline only after the configured failures in a row. */
export const recordHealth = (dir: string, check: HealthCheck, now = Date.now()) =>
  mutate(
    dir,
    (doc) => ({
      doc: {
        ...doc,
        linux: nextHealth(
          doc.linux,
          check,
          doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG,
          doc.heavyOverLimitSeconds * 1000,
          now,
        ),
      },
      result: undefined,
    }),
    now,
  );

/** Waiter-side election: the first caller to find health older than `staleMs` checks Linux itself. */
export const claimHealthCheck = (dir: string, staleMs: number, now = Date.now()) =>
  mutate(
    dir,
    (doc) => {
      const last = doc.linux.checkedAt;
      if (last !== null && now - last < staleMs) return { doc, result: false };
      // Stamps the attempt so other waiters do not check at the same time.
      return { doc: { ...doc, linux: { ...doc.linux, checkedAt: now } }, result: true };
    },
    now,
  );

/**
 * Sends waiter `id` to `runner` (also the answer to its question), or asks a running entry to
 * stop and wait again there. A run Linux could not confirm stopped reruns only with `force`.
 */
export const route = (dir: string, id: string, runner: HeavyRunner, force = false) =>
  mutate(dir, (doc): Decided<MoveResult> => {
    const target = doc.entries.find((entry) => entry.id === id);
    if (target === undefined) return { doc, result: "not-found" };
    if (runner === "linux" && staysOnMac(doc, target)) return { doc, result: "not-allowed" };
    const update = (patch: (entry: HeavyQueueEntry) => HeavyQueueEntry) => ({
      doc: { ...doc, entries: doc.entries.map((e) => (e.id === id ? patch(e) : e)) },
      result: "ok" as const,
    });
    if (target.startedAt !== null) {
      if (target.server === true) return { doc, result: "running" };
      if ((target.runner ?? "mac") === runner) return { doc, result: "ok" };
      return update((entry) => ({ ...entry, requeue: runner }));
    }
    if (target.unconfirmed === true && !force) {
      if (target.ask === undefined) return { doc, result: "unconfirmed" };
      // An answer for Linux runs there once Linux confirms the run stopped; this Mac takes it now.
      return update(({ ask: _ask, forced: _forced, ...entry }) => ({ ...entry, route: runner }));
    }
    const routed = update(
      ({ ask: _ask, unconfirmed: _unconfirmed, forced: _forced, ...entry }) => ({
        ...entry,
        route: runner,
      }),
    );
    if (runner === "mac" || target.unconfirmed !== true) return routed;
    // Forced onto Linux, the rerun takes the folder: only its process group may still be stopped.
    return {
      ...routed,
      doc: {
        ...routed.doc,
        lostRuns: routed.doc.lostRuns.map((lost) =>
          lost.entryId === id ? { ...lost, pgidOnly: true as const } : lost,
        ),
      },
    };
  });

/**
 * Move all: routes every waiter the plan places on the other machine to `runner`, as `route`
 * would each one, and returns their ids. Running jobs and runs Linux has not confirmed stopped
 * stay; for Linux, so do Mac-only work and jobs asked for this Mac, and everything unless Linux is online.
 */
export const routeAll = (dir: string, runner: HeavyRunner, now = Date.now()) =>
  mutate(
    dir,
    (doc): Decided<ReadonlyArray<string>> => {
      if (runner === "linux" && doc.linux.online !== true) return { doc, result: [] };
      const { routes } = planOf(doc, now);
      const moves = doc.entries.filter(
        (entry) =>
          entry.startedAt === null &&
          (routes[entry.id] ?? "mac") !== runner &&
          entry.unconfirmed !== true &&
          !(runner === "linux" && (entry.where === "mac" || staysOnMac(doc, entry))),
      );
      const moved = new Set(moves.map((entry) => entry.id));
      return {
        doc: {
          ...doc,
          entries: doc.entries.map((entry) => {
            if (!moved.has(entry.id)) return entry;
            const { ask: _ask, forced: _forced, ...rest } = entry;
            return { ...rest, route: runner };
          }),
        },
        result: [...moved],
      };
    },
    now,
  );

/** A Linux job's phase and the run folder and process group `remoto` reported. */
export const setProgress = (
  dir: string,
  id: string,
  progress: Pick<QueuedEntry, "phase" | "remote" | "worktree">,
) =>
  mutate(dir, (doc) => ({
    doc: {
      ...doc,
      entries: doc.entries.map((entry) => (entry.id === id ? { ...entry, ...progress } : entry)),
    },
    result: undefined,
  }));

/** Puts a stopped attempt back at the head of the waiters with what decides its next one. */
export const requeue = (
  dir: string,
  id: string,
  next: Pick<
    QueuedEntry,
    | "route"
    | "routeReason"
    | "dropped"
    | "unconfirmed"
    | "linuxFailedAt"
    | "linkFailures"
    | "failure"
  >,
) =>
  mutate(dir, (doc) => {
    const target = doc.entries.find((entry) => entry.id === id);
    if (target === undefined) return { doc, result: false };
    const active = runningOf(doc.entries).filter((entry) => entry.id !== id);
    const waiters = doc.entries.filter((entry) => entry.startedAt === null && entry.id !== id);
    const { routeReason: _reason, held, ...previous }: QueuedEntry = withoutAttempt(target);
    // An attempt that never ran there leaves the question and its deadline, or the answer, as they were.
    const kept = next.dropped !== true && next.route === undefined ? held : undefined;
    const again: QueuedEntry = {
      ...previous,
      ...kept,
      ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
    };
    // A run that lost the link goes back by itself: people hear once it counts Linux unavailable.
    const retrying =
      next.linkFailures !== undefined &&
      next.linkFailures < linkAttempts(doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG);
    const record =
      retrying || kept !== undefined
        ? null
        : requeueRecord(target, next, configFor(doc, target.cwd), Date.now());
    const remote = next.unconfirmed === true ? lostRemoteOf(target) : null;
    const lost: ReadonlyArray<LostRun> =
      remote === null
        ? []
        : [{ key: NodeCrypto.randomUUID(), entryId: id, cwd: target.cwd, remote }];
    return {
      doc: {
        ...doc,
        entries: [...active, again, ...waiters],
        events: withRecord(doc.events, record),
        lostRuns: [...doc.lostRuns, ...lost],
      },
      result: true,
    };
  });

/**
 * The run's folder there: as `remoto` reported it, else as `remoto` names it from its real
 * checkout root, or its real folder outside one (`pwd -P`), for a run lost before it reported one.
 */
const lostRemoteOf = (entry: HeavyQueueEntry): LostRun["remote"] => {
  if (entry.remote !== undefined) return { id: entry.remote.id, pgid: entry.remote.pgid ?? null };
  const folder = gitRootOf(entry.cwd) ?? entry.cwd;
  let real = folder;
  try {
    real = NodeFS.realpathSync(folder);
  } catch {
    // Gone since: its own path is the best guess at what `remoto` saw.
  }
  const sha1 = (text: string) => NodeCrypto.createHash("sha1").update(text).digest("hex");
  return { id: runnerCopyId(real, sha1), pgid: null };
};

/** Keeps its worktree off Linux: all but a forced rerun's record whose process group is known. */
const holdsFolder = (lost: LostRun) => lost.pgidOnly !== true || lost.remote.pgid === null;

const withLost = (doc: QueueDoc, key: string, change: (lost: LostRun) => LostRun | null) => ({
  ...doc,
  lostRuns: doc.lostRuns.flatMap((lost) => {
    if (lost.key !== key) return [lost];
    const next = change(lost);
    return next === null ? [] : [next];
  }),
});

/** Claims stopping one lost run until `until`; false while another process holds it, or it is gone. */
export const claimLostRun = (dir: string, lost: LostRun, until: number, now = Date.now()) =>
  mutate(
    dir,
    (doc) => {
      const held = doc.lostRuns.find((each) => each.key === lost.key);
      if (held === undefined || (held.stoppingUntil ?? 0) > now) return { doc, result: false };
      return {
        doc: withLost(doc, lost.key, (each) => ({ ...each, stoppingUntil: until })),
        result: true,
      };
    },
    now,
  );

/** The process group a forced rerun's lost run had, read before anything new ran in its folder. */
export const resolveLostPgid = (dir: string, lost: LostRun, pgid: number) =>
  mutate(dir, (doc) => ({
    doc: withLost(doc, lost.key, (each) => ({ ...each, remote: { ...each.remote, pgid } })),
    result: undefined,
  }));

/**
 * Ends a stop of a lost run. Confirmed (or nothing left to stop by): the record goes, and its
 * entry, once no other run of it is lost, may run again. Not: the claim made at `claim` is freed,
 * so the next heartbeat tries again; a newer claim stays.
 */
export const settleLostRun = (
  dir: string,
  lost: Pick<LostRun, "key" | "entryId">,
  stopped: boolean,
  claim?: number,
) =>
  mutate(dir, (doc) => {
    if (!stopped) {
      return {
        doc: withLost(doc, lost.key, (each) => {
          if (each.stoppingUntil !== claim) return each;
          const { stoppingUntil: _until, ...free } = each;
          return free;
        }),
        result: undefined,
      };
    }
    const settled = withLost(doc, lost.key, () => null);
    const stillLost = settled.lostRuns.some((each) => each.entryId === lost.entryId);
    return {
      doc: {
        ...settled,
        entries: settled.entries.map((entry) => {
          if (stillLost || entry.id !== lost.entryId || entry.startedAt !== null) return entry;
          const { unconfirmed: _unconfirmed, ...rest } = entry;
          return rest;
        }),
      },
      result: undefined,
    };
  });

/** Reads the script a word names from `cwd`; null when missing, unreadable or too big to read. */
export const scriptReader =
  (cwd: string, home = NodeOS.homedir()): ReadScript =>
  (word) => {
    const path = NodePath.resolve(cwd, word.replace(/^~(?=\/|$)/, home));
    try {
      const stat = NodeFS.statSync(path);
      if (!stat.isFile() || stat.size > SCRIPT_MAX_BYTES) return null;
      return NodeFS.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };

/**
 * The one gate every Bash hook goes through (the `t3 heavy hook` CLI and the in-process Claude
 * callback): with the queue and the Runner both off for the call's folder, nothing is touched.
 */
export const answerBashCall = (
  dir: string,
  hookInput: unknown,
  prefix: string,
  environment: Readonly<Record<string, string | undefined>> = {},
) => {
  const doc = readDoc(dir);
  const cwd =
    isObject(hookInput) && typeof hookInput.cwd === "string" ? hookInput.cwd : process.cwd();
  const command =
    isObject(hookInput) && isObject(hookInput.tool_input) ? hookInput.tool_input.command : null;
  const at =
    typeof command === "string" ? startFolder(lineParts(command).dirs, cwd, NodeOS.homedir()) : cwd;
  const answer = interceptBashCall(
    hookInput,
    prefix,
    modeFor(doc, at),
    environment,
    scriptReader(at),
  );
  return answer !== null && typeof command === "string" && commitRoute(command, at) === "direct"
    ? null
    : answer;
};

/** Remembers a Linux copy to delete once its host answers; newest first, bounded in count and age. */
export const addCopyRemoval = (dir: string, removal: CopyRemoval) =>
  mutate(
    dir,
    (doc) => ({
      doc: {
        ...doc,
        copyRemovals: [
          removal,
          ...doc.copyRemovals.filter(
            (entry) => entry.host !== removal.host || entry.id !== removal.id,
          ),
        ].slice(0, MAX_COPY_REMOVALS),
      },
      result: undefined,
    }),
    removal.at,
  );

/** Drops removals that are done, and ones older than the bound, which no host answered for. */
export const settleCopyRemovals = (
  dir: string,
  done: ReadonlyArray<Pick<CopyRemoval, "host" | "id">>,
  now = Date.now(),
) =>
  mutate(
    dir,
    (doc) => ({
      doc: {
        ...doc,
        copyRemovals: doc.copyRemovals.filter(
          (entry) =>
            now - entry.at < COPY_REMOVAL_TTL_MS &&
            !done.some((settled) => settled.host === entry.host && settled.id === entry.id),
        ),
      },
      result: undefined,
    }),
    now,
  );
