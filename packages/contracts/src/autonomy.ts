import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Autonomy lets assistants wake on their own. The server evaluates fixed rules and watches against
 * its own events without a model; only a match sends the assistant a compact message.
 */
export const AUTONOMY_RULES = [
  "runFailed",
  "waitingTooLong",
  "stuck",
  "ciFailed",
  "reviewIncomplete",
] as const;
export const AutonomyRule = Schema.Literals(AUTONOMY_RULES);
export type AutonomyRule = typeof AutonomyRule.Type;

export const AUTONOMY_CHANNELS = ["telegram", "t3"] as const;
export const AutonomyChannel = Schema.Literals(AUTONOMY_CHANNELS);
export type AutonomyChannel = typeof AutonomyChannel.Type;

const Minutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 * 60 }));

/** Global switches, in server settings. `enabled` is the pause switch for all autonomy. */
export const AutonomySettings = Schema.Struct({
  enabled: Schema.Boolean,
  rules: Schema.Struct({
    runFailed: Schema.Boolean,
    waitingTooLong: Schema.Boolean,
    stuck: Schema.Boolean,
    ciFailed: Schema.Boolean,
    // Added after the first release: settings saved before it have no key.
    reviewIncomplete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  }),
  waitingMinutes: Minutes,
  stuckMinutes: Minutes,
  channels: Schema.Array(AutonomyChannel),
  maxWakesPerDay: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  // The keys below came after the first release: settings saved before them decode to defaults.
  /** Tells the user directly, with no model, when an agent waits on them. */
  notifyWaiting: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** How long a request may wait before that notice; one answered sooner is never sent. */
  notifyWaitingAfterMinutes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(1)),
  ),
  /** Messages each assistant may send the user per day with `t3_assistant` `notify_user`. */
  maxUserMessagesPerDay: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(20)),
  ),
});
export type AutonomySettings = typeof AutonomySettings.Type;

export const DEFAULT_AUTONOMY_SETTINGS: AutonomySettings = {
  enabled: false,
  rules: {
    runFailed: true,
    waitingTooLong: true,
    stuck: true,
    ciFailed: true,
    reviewIncomplete: true,
  },
  waitingMinutes: 30,
  stuckMinutes: 15,
  channels: ["telegram", "t3"],
  maxWakesPerDay: 20,
  notifyWaiting: true,
  notifyWaitingAfterMinutes: 1,
  maxUserMessagesPerDay: 20,
};

export const AUTONOMY_MODES = ["reply-only", "reply-and-notify"] as const;
export const AutonomyMode = Schema.Literals(AUTONOMY_MODES);
export type AutonomyMode = typeof AutonomyMode.Type;

/** Stored with the assistant. A null list inherits; an explicit list (even empty) overrides. */
export const AssistantAutonomy = Schema.Struct({
  mode: AutonomyMode,
  /** Null inherits the global rule toggles. */
  rules: Schema.NullOr(Schema.Array(AutonomyRule)),
  /** Null covers all projects. */
  projectIds: Schema.NullOr(Schema.Array(ProjectId)),
  /** Null inherits the global channels. */
  channels: Schema.NullOr(Schema.Array(AutonomyChannel)),
});
export type AssistantAutonomy = typeof AssistantAutonomy.Type;

export const DEFAULT_ASSISTANT_AUTONOMY: AssistantAutonomy = {
  mode: "reply-only",
  rules: null,
  projectIds: null,
  channels: null,
};

export const AUTONOMY_WATCH_EVENTS = [
  "run_finished",
  "run_failed",
  "pr_checks_passed",
  "pr_checks_failed",
  "card_moved",
] as const;
export const AutonomyWatchEvent = Schema.Literals(AUTONOMY_WATCH_EVENTS);
export type AutonomyWatchEvent = typeof AutonomyWatchEvent.Type;

export const AutonomyWatchId = TrimmedNonEmptyString.pipe(Schema.brand("AutonomyWatchId"));
export type AutonomyWatchId = typeof AutonomyWatchId.Type;

export const AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH = 2_000;

/** Absent fields match anything. */
export const AutonomyWatchFilter = Schema.Struct({
  event: AutonomyWatchEvent,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  prNumber: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type AutonomyWatchFilter = typeof AutonomyWatchFilter.Type;

const WatchInputFields = {
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  filter: AutonomyWatchFilter,
  /** What the assistant should do when the watch matches; the assistant never changes anything unasked. */
  instruction: Schema.String.check(Schema.isMaxLength(AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH)),
  /** Disables itself after the first match. */
  oneShot: Schema.Boolean,
  /** After this the watch no longer matches. */
  expiresAt: Schema.NullOr(IsoDateTime),
};

export const AutonomyWatch = Schema.Struct({
  id: AutonomyWatchId,
  /** The assistant that wakes; it must be in reply-and-notify mode to be woken. */
  assistantId: TrimmedNonEmptyString,
  ...WatchInputFields,
  enabled: Schema.Boolean,
  triggerCount: Schema.Int,
  lastTriggeredAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type AutonomyWatch = typeof AutonomyWatch.Type;

export const AutonomyWatchesListInput = Schema.Struct({});
export const AutonomyWatchesListResult = Schema.Struct({ watches: Schema.Array(AutonomyWatch) });
export type AutonomyWatchesListResult = typeof AutonomyWatchesListResult.Type;

/** Without `id` it creates; with one it replaces that watch's fields. */
export const AutonomyWatchUpsertInput = Schema.Struct({
  id: Schema.optional(AutonomyWatchId),
  assistantId: TrimmedNonEmptyString,
  ...WatchInputFields,
  enabled: Schema.optional(Schema.Boolean),
});
export type AutonomyWatchUpsertInput = typeof AutonomyWatchUpsertInput.Type;

export const AutonomyWatchSetEnabledInput = Schema.Struct({
  id: AutonomyWatchId,
  enabled: Schema.Boolean,
});
export type AutonomyWatchSetEnabledInput = typeof AutonomyWatchSetEnabledInput.Type;

export const AutonomyWatchDeleteInput = Schema.Struct({ id: AutonomyWatchId });
export type AutonomyWatchDeleteInput = typeof AutonomyWatchDeleteInput.Type;
export const AutonomyWatchDeleteResult = Schema.Struct({ id: AutonomyWatchId });

export class AutonomyError extends Schema.TaggedError<AutonomyError>()("AutonomyError", {
  reason: Schema.Literals(["not_found", "invalid", "storage"]),
  message: Schema.String,
}) {}
