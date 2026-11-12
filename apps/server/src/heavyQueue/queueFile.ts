// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The machine-wide heavy-work queue as one JSON file. Plain Node and synchronous: the `t3 heavy`
 * CLI fast path loads it before the Effect runtime, and every T3 server on the machine shares it.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  HeavyQueueEntry,
  HeavyQueueRule,
  HeavyRunner,
  RunnerProjectConfig,
} from "@t3tools/contracts";

import {
  DEFAULT_MAX_RUNNING,
  hasHeadroom,
  HISTORY_RUNS,
  signatureOf,
  type History,
  type Run,
  type Sample,
  SAMPLE_FRESH_MS,
  workersFor,
} from "./admission.ts";
import { interceptBashCall } from "./heavyHook.ts";
import {
  DEFAULT_MACHINE_CONFIG,
  eligibilityOf,
  mayPublish,
  nextHealth,
  planRoutes,
  runnerConfigFor,
  UNKNOWN_HEALTH,
  type HealthCheck,
  type LinuxHealth,
  type RoutePlan,
  type RunnerBlock,
  type WorkContext,
} from "./runner.ts";

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;
/** A longer silence between readings restarts the steady-headroom window. */
const SAMPLE_GAP_MS = 10_000;

/** Machine-wide on purpose, so it is outside any server's userdata. The env override isolates a dev server under test. */
export const defaultQueueDir = () =>
  process.env.T3CODE_HEAVY_QUEUE_DIR ?? NodePath.join(NodeOS.homedir(), ".t3", "heavy-queue");

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
  readonly history: History;
  /** The latest machine reading a server published; waiters cannot measure free memory themselves. */
  readonly sample: Sample | null;
  readonly lastStartAt: number | null;
  readonly holding: boolean;
  /** Minutes without use before T3 shuts an idle simulator or emulator down; 0 never. */
  readonly deviceIdleMinutes: number;
  /** Runner settings a server published; null reads as the Runner off everywhere. */
  readonly runner: RunnerBlock | null;
  readonly linux: LinuxHealth;
}

const DEFAULT_DEVICE_IDLE_MINUTES = 20;

const EMPTY_DOC: QueueDoc = {
  entries: [],
  enabled: true,
  paused: false,
  rules: [],
  maxRunning: DEFAULT_MAX_RUNNING,
  history: {},
  sample: null,
  lastStartAt: null,
  holding: false,
  deviceIdleMinutes: DEFAULT_DEVICE_IDLE_MINUTES,
  runner: null,
  linux: UNKNOWN_HEALTH,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A block missing any part reads as no block, so a half-written one never routes anything. */
const parseRunner = (value: unknown): RunnerBlock | null =>
  isObject(value) &&
  isObject(value.global) &&
  isObject(value.machine) &&
  Array.isArray(value.projects) &&
  isObject(value.publisher)
    ? (value as unknown as RunnerBlock)
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
      sample?: unknown;
      lastStartAt?: unknown;
      holding?: unknown;
      deviceIdleMinutes?: unknown;
      runner?: unknown;
      linux?: unknown;
    } | null;
    return {
      // Keys this version does not know stay in the file for the versions that do.
      ...(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}),
      entries: Array.isArray(parsed?.entries) ? (parsed.entries as HeavyQueueEntry[]) : [],
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
      runner: parseRunner(parsed?.runner),
      linux: isObject(parsed?.linux) ? { ...UNKNOWN_HEALTH, ...parsed.linux } : UNKNOWN_HEALTH,
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
    }
  | {
      readonly status: "waiting";
      readonly position: number;
      readonly running?: HeavyQueueEntry;
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

const contextOf =
  (doc: QueueDoc) =>
  (cwd: string): WorkContext => ({
    config: configFor(doc, cwd),
    worktree: cachedCheckout(cwd).root,
  });

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
    now,
    contextOf: contextOf(doc),
    machine: doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG,
    health: doc.linux,
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
      doc: { ...doc, entries: entries.filter((e) => e.id !== id) },
      result: { status: "canceled", reason: canceled },
    };
  }
  const admit = decision.admits[id];
  if (admit !== undefined) {
    const gated = admit.runner === "mac" && !admit.ungated;
    const fresh = sample !== null && now - sample.at <= SAMPLE_FRESH_MS;
    const workers = gated ? workersFor(cpuCount, fresh ? sample.busyCores : null) : null;
    const {
      ask: _ask,
      route: _route,
      dropped: _dropped,
      linuxFailedAt: _failed,
      unconfirmed: _unconfirmed,
      ...rest
    } = entry;
    const started: HeavyQueueEntry = {
      ...rest,
      startedAt: new Date(now).toISOString(),
      ...(workers === null ? {} : { workers }),
      ...(admit.runner === "linux" ? { runner: "linux" as const } : {}),
      ...(admit.ungated ? { ungated: true } : {}),
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
      },
      result: {
        status: "started",
        workers,
        ...(admit.runner === "linux" ? { runner: "linux" as const } : {}),
        ...(admit.ungated ? { ungated: true as const } : {}),
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
  return {
    doc: { ...doc, entries: asked, holding: decision.holding },
    result: {
      status: "waiting",
      position: index - active.length + 1,
      ...(active[0] === undefined ? {} : { running: active[0] }),
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

const withFinishedRuns = (before: QueueDoc, after: QueueDoc, now: number): QueueDoc => {
  const kept = new Set(after.entries.map((entry) => entry.id));
  const history: Record<string, ReadonlyArray<Run>> = { ...after.history };
  let changed = false;
  for (const gone of before.entries) {
    if (gone.startedAt === null || kept.has(gone.id) || gone.peakMemory === undefined) continue;
    const signature = signatureOf(gone.label);
    const run = {
      cpu: gone.peakCpu ?? 0,
      memoryBytes: gone.peakMemory,
      durationMs: Math.max(0, now - Date.parse(gone.startedAt)),
    };
    history[signature] = [...(history[signature] ?? []), run].slice(-HISTORY_RUNS);
    changed = true;
  }
  return changed ? { ...after, history } : after;
};

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

export const enqueue = (dir: string, entry: HeavyQueueEntry) =>
  mutate(dir, (doc) => ({ doc: insertNew(doc, entry), result: undefined }));

export const tryStart = (dir: string, id: string, now = Date.now()) =>
  mutate(dir, (doc) => decideStart(doc, id, now), now);

/** What the admission rules say right now, without starting anyone. */
export const readPlan = (dir: string, now = Date.now()) => {
  const doc = readDoc(dir);
  return { doc, plan: planOf(doc, now) };
};

/** A server publishes the machine reading and each running job's process-tree peak. */
export const recordSample = (
  dir: string,
  reading: Omit<Sample, "headroomSince">,
  peaks: Readonly<Record<string, { readonly cpu: number; readonly memoryBytes: number }>>,
) =>
  mutate(dir, (doc) => {
    const sample: Sample = {
      ...reading,
      headroomSince: !hasHeadroom(reading)
        ? null
        : doc.sample !== null && reading.at - doc.sample.at < SAMPLE_GAP_MS
          ? (doc.sample.headroomSince ?? reading.at)
          : reading.at,
    };
    return {
      doc: {
        ...doc,
        sample,
        entries: doc.entries.map((entry) => {
          const peak = peaks[entry.id];
          return entry.startedAt === null || peak === undefined
            ? entry
            : {
                ...entry,
                cpu: peak.cpu,
                memory: peak.memoryBytes,
                peakCpu: Math.max(entry.peakCpu ?? 0, peak.cpu),
                peakMemory: Math.max(entry.peakMemory ?? 0, peak.memoryBytes),
              };
        }),
      },
      result: undefined,
    };
  });

/** Waiter-side election: the first caller under the lock to find the reading stale becomes the sampler. */
export const recordSampleIfStale = (
  dir: string,
  reading: Omit<Sample, "headroomSince">,
  staleMs: number,
) => {
  const current = readDoc(dir).sample;
  if (current !== null && reading.at - current.at < staleMs) return false;
  recordSample(dir, reading, {});
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
    if (target.startedAt !== null) return { doc, result: { result: "ok", entry: target } };
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

/** Exclusive work and its project's Mac-only list never leave this Mac. */
export const staysOnMac = (doc: Pick<QueueDoc, "runner">, entry: HeavyQueueEntry) => {
  const eligibility = eligibilityOf(entry, configFor(doc, entry.cwd));
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
          (doc.runner?.machine ?? DEFAULT_MACHINE_CONFIG).runnerOfflineAfterFailures,
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
    if (target.unconfirmed === true && !force) return { doc, result: "unconfirmed" };
    return update(({ ask: _ask, unconfirmed: _unconfirmed, forced: _forced, ...entry }) => ({
      ...entry,
      route: runner,
    }));
  });

/** A Linux job's phase and the run folder and process group `remoto` reported. */
export const setProgress = (
  dir: string,
  id: string,
  progress: Pick<HeavyQueueEntry, "phase" | "remote">,
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
  next: Pick<HeavyQueueEntry, "route" | "dropped" | "unconfirmed" | "linuxFailedAt">,
) =>
  mutate(dir, (doc) => {
    const target = doc.entries.find((entry) => entry.id === id);
    if (target === undefined) return { doc, result: false };
    const active = runningOf(doc.entries).filter((entry) => entry.id !== id);
    const waiters = doc.entries.filter((entry) => entry.startedAt === null && entry.id !== id);
    const again: HeavyQueueEntry = {
      ...withoutAttempt(target),
      ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
    };
    return { doc: { ...doc, entries: [...active, again, ...waiters] }, result: true };
  });

/** The remote run is confirmed stopped: the entry may run again. */
export const confirmStopped = (dir: string, id: string) =>
  mutate(dir, (doc) => ({
    doc: {
      ...doc,
      entries: doc.entries.map((entry) => {
        if (entry.id !== id) return entry;
        const { unconfirmed: _unconfirmed, ...rest } = entry;
        return rest;
      }),
    },
    result: undefined,
  }));

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
  return interceptBashCall(hookInput, prefix, modeFor(doc, cwd), environment);
};
