import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** One heavy job waiting for, or holding, this machine's single heavy-work slot. */
export const HeavyQueueEntry = Schema.Struct({
  id: Schema.String,
  pid: Schema.Int,
  /** The agent thread that queued it; null when run outside an agent. */
  threadId: Schema.NullOr(Schema.String),
  label: Schema.String,
  /** Short human title given with `--name`; absent on older entries. */
  name: Schema.optionalKey(Schema.String),
  cwd: Schema.String,
  createdAt: Schema.String,
  /** Set once the entry holds the slot; at most one entry has it. */
  startedAt: Schema.NullOr(Schema.String),
  /** Set once someone reordered it by hand; new arrivals then never jump ahead of it. */
  pinned: Schema.optionalKey(Schema.Boolean),
  /** Who last reordered it, when anyone did. */
  note: Schema.optionalKey(Schema.String),
  /** The user released it: it starts at once, even when slots are full, the machine is loaded or the queue is paused. */
  forced: Schema.optionalKey(Schema.Boolean),
  /** Held by a T3 server itself rather than a `t3 heavy` command, so it cannot be stopped by signal. */
  server: Schema.optionalKey(Schema.Boolean),
  /** Latest cores and resident bytes of its process tree, refreshed each sample while it runs. */
  cpu: Schema.optionalKey(Schema.Number),
  memory: Schema.optionalKey(Schema.Number),
  /** Peak cores and resident bytes of its process tree so far, sampled while it runs. */
  peakCpu: Schema.optionalKey(Schema.Number),
  peakMemory: Schema.optionalKey(Schema.Number),
});
export type HeavyQueueEntry = typeof HeavyQueueEntry.Type;

/** Entries from this folder (and below) go ahead of ("first") or behind ("last") normal ones. */
export const HeavyQueueRule = Schema.Struct({
  root: Schema.String,
  priority: Schema.Literals(["first", "last"]),
});
export type HeavyQueueRule = typeof HeavyQueueRule.Type;

export const HeavyQueueMachine = Schema.Struct({
  busyCores: Schema.Number,
  cpuCount: Schema.Number,
  availableMemoryBytes: Schema.Number,
  totalMemoryBytes: Schema.Number,
});

/** Machine-wide, in run order: the running entry (if any) first, then waiters. */
/** What a command usually uses, from its finished runs; absent when it has no history. */
export const HeavyQueueEstimate = Schema.Struct({
  cpu: Schema.Number,
  memoryBytes: Schema.Number,
  durationMs: Schema.Number,
});

export const HeavyQueueState = Schema.Struct({
  /** Usual usage of each waiting entry that has history, by entry id. */
  estimates: Schema.optionalKey(Schema.Record(Schema.String, HeavyQueueEstimate)),
  entries: Schema.Array(HeavyQueueEntry),
  /** While true nothing new starts; the running entry continues. */
  paused: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  rules: Schema.Array(HeavyQueueRule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** How many entries may run at once. */
  maxRunning: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  /** Why a waiting entry is not starting, by entry id. */
  reasons: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** The latest reading the admission rules used; null when no server has published a fresh one. */
  machine: Schema.NullOr(HeavyQueueMachine).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** False while pressure, the pause or an exclusive job is what holds waiters back. */
  room: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type HeavyQueueState = typeof HeavyQueueState.Type;

export const HeavyQueueEntryInput = Schema.Struct({ id: Schema.String });
export type HeavyQueueEntryInput = typeof HeavyQueueEntryInput.Type;

/** Puts a waiter before `beforeId`, or last when null. */
export const HeavyQueueMoveInput = Schema.Struct({
  id: Schema.String,
  beforeId: Schema.NullOr(Schema.String),
});
export type HeavyQueueMoveInput = typeof HeavyQueueMoveInput.Type;

export const HeavyQueueSetPausedInput = Schema.Struct({ paused: Schema.Boolean });
export type HeavyQueueSetPausedInput = typeof HeavyQueueSetPausedInput.Type;

export const HeavyQueueSetMaxRunningInput = Schema.Struct({ maxRunning: Schema.Int });
export type HeavyQueueSetMaxRunningInput = typeof HeavyQueueSetMaxRunningInput.Type;

/** A null priority clears the rule. */
export const HeavyQueueSetRuleInput = Schema.Struct({
  root: Schema.String,
  priority: Schema.NullOr(Schema.Literals(["first", "last"])),
});
export type HeavyQueueSetRuleInput = typeof HeavyQueueSetRuleInput.Type;

export class HeavyQueueError extends Schema.TaggedError<HeavyQueueError>()("HeavyQueueError", {
  reason: Schema.Literals(["not-found", "running", "unavailable"]),
  message: Schema.String,
}) {}
