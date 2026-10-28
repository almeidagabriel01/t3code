import * as Schema from "effect/Schema";

export const ForkUpdateStatusInput = Schema.Struct({
  /** Fork checkout folder. A leading `~` expands on the server. Empty means the default folder. */
  path: Schema.String,
});
export type ForkUpdateStatusInput = typeof ForkUpdateStatusInput.Type;

export const ForkUpdateStatus = Schema.Struct({
  /** False when the folder is not a git checkout with an `upstream` remote on this host. */
  available: Schema.Boolean,
  path: Schema.String,
  headSha: Schema.NullOr(Schema.String),
  headSubject: Schema.NullOr(Schema.String),
  /** Latest release tag already merged into main. */
  headTag: Schema.NullOr(Schema.String),
  upstreamSha: Schema.NullOr(Schema.String),
  upstreamTag: Schema.NullOr(Schema.String),
  behind: Schema.Number,
  /** Null when git cannot predict it (old git) or nothing is pending. */
  wouldConflict: Schema.NullOr(Schema.Boolean),
  conflictFiles: Schema.Array(Schema.String),
});
export type ForkUpdateStatus = typeof ForkUpdateStatus.Type;
