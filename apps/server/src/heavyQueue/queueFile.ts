// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The machine-wide heavy-work queue as one JSON file. Plain Node and synchronous: the `t3 heavy`
 * CLI fast path loads it before the Effect runtime, and every T3 server on the machine shares it.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { HeavyQueueEntry, HeavyQueueRule } from "@t3tools/contracts";

import {
  DEFAULT_MAX_RUNNING,
  hasHeadroom,
  HISTORY_RUNS,
  plan,
  signatureOf,
  type History,
  type Plan,
  type Run,
  type Sample,
  SAMPLE_FRESH_MS,
  workersFor,
} from "./admission.ts";

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
};

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
  | { readonly status: "started"; readonly workers: number }
  | {
      readonly status: "waiting";
      readonly position: number;
      readonly running?: HeavyQueueEntry;
      readonly paused?: true;
      /** Why it is not starting, for people; changes as the machine does. */
      readonly reason?: string;
    }
  | { readonly status: "removed" };

type Decided<A> = { readonly doc: QueueDoc; readonly result: A };

const planOf = (doc: QueueDoc, now: number): Plan =>
  plan({
    entries: doc.entries,
    maxRunning: doc.maxRunning,
    enabled: doc.enabled,
    paused: doc.paused,
    history: doc.history,
    sample: doc.sample,
    lastStartAt: doc.lastStartAt,
    holding: doc.holding,
    now,
  });

/** Starts `id` when the admission plan picks it; running entries stay in front, so index order is wait order. */
const decideStart = (doc: QueueDoc, id: string, now: number): Decided<StartResult> => {
  const { entries } = doc;
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return { doc, result: { status: "removed" } };
  const { sample } = doc;
  const cpuCount = sample?.cpuCount ?? NodeOS.availableParallelism();
  if (entries[index]!.startedAt !== null) {
    return {
      doc,
      result: { status: "started", workers: entries[index]!.workers ?? workersFor(cpuCount, null) },
    };
  }
  const decision = planOf(doc, now);
  const active = runningOf(entries);
  if (!doc.enabled || decision.admit === id) {
    const fresh = sample !== null && now - sample.at <= SAMPLE_FRESH_MS;
    const workers = workersFor(cpuCount, fresh ? sample.busyCores : null);
    const started = { ...entries[index]!, startedAt: new Date(now).toISOString(), workers };
    return {
      doc: {
        ...doc,
        entries: [
          ...active,
          started,
          ...entries.filter((e) => e.startedAt === null && e.id !== id),
        ],
        lastStartAt: now,
        holding: decision.holding,
      },
      result: { status: "started", workers },
    };
  }
  return {
    doc: { ...doc, holding: decision.holding },
    result: {
      status: "waiting",
      position: index - active.length + 1,
      ...(active[0] === undefined ? {} : { running: active[0] }),
      ...(doc.paused ? { paused: true as const } : {}),
      ...(decision.reasons[id] === undefined ? {} : { reason: decision.reasons[id] }),
    },
  };
};

export type MoveResult = "ok" | "not-found" | "running";

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
 * "high" on a waiter releases it at once, like `startNow`; "low" takes that back. On a running job
 * it only records the level: the caller changes its processes' QoS.
 */
export const setPriority = (dir: string, id: string, priority: "low" | "high") =>
  mutate(dir, (doc): Decided<{ readonly result: MoveResult; readonly entry?: HeavyQueueEntry }> => {
    const target = doc.entries.find((entry) => entry.id === id);
    if (target === undefined) return { doc, result: { result: "not-found" } };
    const { forced: _forced, ...rest } = target;
    const waiting = target.startedAt === null;
    const updated: HeavyQueueEntry = {
      ...rest,
      priority,
      ...(waiting && priority === "high" ? { forced: true } : {}),
      ...(!waiting && target.forced === true ? { forced: true } : {}),
    };
    return {
      doc: { ...doc, entries: doc.entries.map((entry) => (entry.id === id ? updated : entry)) },
      result: { result: "ok", entry: updated },
    };
  });

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
