import * as Schema from "effect/Schema";

/** `auto` follows the fork's own desktop version. */
export const ForkUpdateChannelSetting = Schema.Literals(["auto", "stable", "nightly"]);

export const ForkUpdateStatusInput = Schema.Struct({
  /** Fork checkout folder. A leading `~` expands on the server. Empty means the default folder. */
  path: Schema.String,
  channel: ForkUpdateChannelSetting,
});
export type ForkUpdateStatusInput = typeof ForkUpdateStatusInput.Type;

export const ForkUpdateStatus = Schema.Struct({
  /** False when the folder is not a git checkout with an `upstream` remote on this host. */
  available: Schema.Boolean,
  path: Schema.String,
  /** The channel the check followed, after resolving `auto`. */
  channel: Schema.Literals(["stable", "nightly"]),
  headSha: Schema.NullOr(Schema.String),
  headSubject: Schema.NullOr(Schema.String),
  /** Latest tag of the channel already merged into main. */
  headTag: Schema.NullOr(Schema.String),
  upstreamSha: Schema.NullOr(Schema.String),
  /** Latest upstream tag of the channel. */
  upstreamTag: Schema.NullOr(Schema.String),
  behind: Schema.Number,
  /** Null when git cannot predict it (old git) or nothing is pending. */
  wouldConflict: Schema.NullOr(Schema.Boolean),
  conflictFiles: Schema.Array(Schema.String),
});
export type ForkUpdateStatus = typeof ForkUpdateStatus.Type;
