import * as Schema from "effect/Schema";

/** One heavy job waiting for, or holding, this machine's single heavy-work slot. */
export const HeavyQueueEntry = Schema.Struct({
  id: Schema.String,
  pid: Schema.Int,
  /** The agent thread that queued it; null when run outside an agent. */
  threadId: Schema.NullOr(Schema.String),
  label: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.String,
  /** Set once the entry holds the slot; at most one entry has it. */
  startedAt: Schema.NullOr(Schema.String),
});
export type HeavyQueueEntry = typeof HeavyQueueEntry.Type;

/** Machine-wide, in run order: the running entry (if any) first, then waiters. */
export const HeavyQueueState = Schema.Struct({
  entries: Schema.Array(HeavyQueueEntry),
});
export type HeavyQueueState = typeof HeavyQueueState.Type;

export const HeavyQueueEntryInput = Schema.Struct({ id: Schema.String });
export type HeavyQueueEntryInput = typeof HeavyQueueEntryInput.Type;

export class HeavyQueueError extends Schema.TaggedError<HeavyQueueError>()("HeavyQueueError", {
  reason: Schema.Literals(["not-found", "running", "unavailable"]),
  message: Schema.String,
}) {}
