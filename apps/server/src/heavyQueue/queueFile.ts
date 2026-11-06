// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The machine-wide heavy-work queue as one JSON file. Plain Node and synchronous: the `t3 heavy`
 * CLI fast path loads it before the Effect runtime, and every T3 server on the machine shares it.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { HeavyQueueEntry } from "@t3tools/contracts";

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;

/** Machine-wide on purpose, so it is outside any server's userdata. */
export const defaultQueueDir = () => NodePath.join(NodeOS.homedir(), ".t3", "heavy-queue");

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

const load = (dir: string): ReadonlyArray<HeavyQueueEntry> => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(queuePath(dir), "utf8"));
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) ? (entries as HeavyQueueEntry[]) : [];
  } catch {
    return [];
  }
};

const save = (dir: string, entries: ReadonlyArray<HeavyQueueEntry>) => {
  const temp = `${queuePath(dir)}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify({ entries }));
  NodeFS.renameSync(temp, queuePath(dir));
};

const prune = (entries: ReadonlyArray<HeavyQueueEntry>) =>
  entries.filter((entry) => isAlive(entry.pid));

const running = (entries: ReadonlyArray<HeavyQueueEntry>) =>
  entries.find((entry) => entry.startedAt !== null);

export type StartResult =
  | { readonly status: "started" }
  | { readonly status: "waiting"; readonly position: number; readonly running?: HeavyQueueEntry }
  | { readonly status: "removed" };

/** Starts `id` only when nothing else holds the slot and it is first in line. */
const decideStart = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  id: string,
  now: string,
): { readonly entries: ReadonlyArray<HeavyQueueEntry>; readonly result: StartResult } => {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return { entries, result: { status: "removed" } };
  const holder = running(entries);
  if (holder?.id === id) return { entries, result: { status: "started" } };
  if (holder === undefined && index === 0) {
    return {
      entries: entries.map((entry) => (entry.id === id ? { ...entry, startedAt: now } : entry)),
      result: { status: "started" },
    };
  }
  // The running entry sits first, so a waiter's index is its 1-based position among waiters.
  return {
    entries,
    result: {
      status: "waiting",
      position: holder === undefined ? index + 1 : index,
      ...(holder === undefined ? {} : { running: holder }),
    },
  };
};

export type MoveResult = "ok" | "not-found" | "running";

/** Moves a waiter right behind the running entry, or to the front when nothing runs. */
const decidePromote = (entries: ReadonlyArray<HeavyQueueEntry>, id: string) => {
  const target = entries.find((entry) => entry.id === id);
  if (target === undefined) return { entries, result: "not-found" as MoveResult };
  if (target.startedAt !== null) return { entries, result: "running" as MoveResult };
  const rest = entries.filter((entry) => entry.id !== id);
  const at = running(rest) === undefined ? 0 : 1;
  return {
    entries: [...rest.slice(0, at), target, ...rest.slice(at)],
    result: "ok" as MoveResult,
  };
};

const decideCancel = (entries: ReadonlyArray<HeavyQueueEntry>, id: string) => {
  const target = entries.find((entry) => entry.id === id);
  if (target === undefined) return { entries, result: "not-found" as MoveResult };
  if (target.startedAt !== null) return { entries, result: "running" as MoveResult };
  return { entries: entries.filter((entry) => entry.id !== id), result: "ok" as MoveResult };
};

const mutate = <A>(
  dir: string,
  decide: (entries: ReadonlyArray<HeavyQueueEntry>) => {
    readonly entries: ReadonlyArray<HeavyQueueEntry>;
    readonly result: A;
  },
) =>
  withLock(dir, () => {
    const decided = decide(prune(load(dir)));
    save(dir, decided.entries);
    return decided.result;
  });

/** Pruned view; never writes, tolerates a missing or corrupt file. */
export const read = (dir: string): ReadonlyArray<HeavyQueueEntry> => prune(load(dir));

export const enqueue = (dir: string, entry: HeavyQueueEntry) =>
  mutate(dir, (entries) => ({ entries: [...entries, entry], result: undefined }));

export const tryStart = (dir: string, id: string) =>
  mutate(dir, (entries) => decideStart(entries, id, new Date().toISOString()));

export const remove = (dir: string, id: string) =>
  mutate(dir, (entries) => ({
    entries: entries.filter((entry) => entry.id !== id),
    result: undefined,
  }));

export const promote = (dir: string, id: string) =>
  mutate(dir, (entries) => decidePromote(entries, id));

export const cancel = (dir: string, id: string) =>
  mutate(dir, (entries) => decideCancel(entries, id));
