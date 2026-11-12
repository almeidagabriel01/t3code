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
  /** Agents' jobs run "low" (background QoS on macOS) and the user's "normal"; "high" was asked for. Absent on older entries. */
  priority: Schema.optionalKey(Schema.Literals(["low", "normal", "high"])),
  /** Worker count its test runners were given when it started: the cores free then. */
  workers: Schema.optionalKey(Schema.Int),
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
  /** False switches the queue off: every heavy job starts at once and agents are not asked first. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
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
  /** The user's Claude Code settings send heavy Bash calls through the queue in every session. */
  claudeHookInstalled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Minutes without use before a simulator or emulator T3 started is shut down; 0 never. */
  deviceIdleMinutes: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(20))),
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

export const HeavyQueueSetEnabledInput = Schema.Struct({ enabled: Schema.Boolean });
export type HeavyQueueSetEnabledInput = typeof HeavyQueueSetEnabledInput.Type;

export const HeavyQueueSetMaxRunningInput = Schema.Struct({ maxRunning: Schema.Int });
export type HeavyQueueSetMaxRunningInput = typeof HeavyQueueSetMaxRunningInput.Type;

/** A null priority clears the rule. */
/** "high" starts a waiter now and lifts a running job's processes out of background QoS; "low" puts them back. */
export const HeavyQueueSetPriorityInput = Schema.Struct({
  id: Schema.String,
  priority: Schema.Literals(["low", "high"]),
});
export type HeavyQueueSetPriorityInput = typeof HeavyQueueSetPriorityInput.Type;

/** Installs or removes the `t3 heavy hook` PreToolUse entry in the user's Claude Code settings. */
export const HeavyQueueSetClaudeHookInput = Schema.Struct({ installed: Schema.Boolean });
export type HeavyQueueSetClaudeHookInput = typeof HeavyQueueSetClaudeHookInput.Type;

/** 0 never shuts an idle simulator or emulator down. */
export const HeavyQueueSetDeviceIdleMinutesInput = Schema.Struct({ minutes: Schema.Int });
export type HeavyQueueSetDeviceIdleMinutesInput = typeof HeavyQueueSetDeviceIdleMinutesInput.Type;

export const HeavyQueueSetRuleInput = Schema.Struct({
  root: Schema.String,
  priority: Schema.NullOr(Schema.Literals(["first", "last"])),
});
export type HeavyQueueSetRuleInput = typeof HeavyQueueSetRuleInput.Type;

/**
 * A heavy command running now: a started queue entry, or a process tree an agent or terminal runs
 * directly. Cores and bytes sum its process tree.
 */
export const HeavyCommand = Schema.Struct({
  source: Schema.Literals(["queue", "agent", "terminal"]),
  /** The queue entry, for queue rows; Stop goes through the queue's cancel. */
  entryId: Schema.optionalKey(Schema.String),
  pid: Schema.Int,
  startTimeMs: Schema.Int,
  threadId: Schema.NullOr(Schema.String),
  /** Known for queue rows; a direct command's project comes from its thread. */
  cwd: Schema.optionalKey(Schema.String),
  /** The root command line. */
  label: Schema.String,
  name: Schema.String,
  startedAt: Schema.String,
  /** False for work the T3 server itself holds, which no signal can stop. */
  stoppable: Schema.Boolean,
  cpu: Schema.optionalKey(Schema.Number),
  memory: Schema.optionalKey(Schema.Number),
  /** Highest tree total seen so far. */
  peakCpu: Schema.optionalKey(Schema.Number),
  peakMemory: Schema.optionalKey(Schema.Number),
});
export type HeavyCommand = typeof HeavyCommand.Type;

export const HeavyCommandsState = Schema.Struct({
  commands: Schema.Array(HeavyCommand),
  cpuCount: Schema.Int,
});
export type HeavyCommandsState = typeof HeavyCommandsState.Type;

export const HeavyCommandStopInput = Schema.Struct({ pid: Schema.Int, startTimeMs: Schema.Int });
export type HeavyCommandStopInput = typeof HeavyCommandStopInput.Type;

export const HeavyCommandStopResult = Schema.Struct({
  outcome: Schema.Literals(["terminated", "killed", "already-exited"]),
});
export type HeavyCommandStopResult = typeof HeavyCommandStopResult.Type;

export class HeavyQueueError extends Schema.TaggedError<HeavyQueueError>()("HeavyQueueError", {
  reason: Schema.Literals(["not-found", "running", "unavailable"]),
  message: Schema.String,
}) {}
