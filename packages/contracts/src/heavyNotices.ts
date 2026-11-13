/**
 * Notices about heavy jobs: problems on either machine and moves between this Mac and Linux. The
 * server decides them from queue transitions; clients only show them.
 */
import * as Schema from "effect/Schema";

import { HeavyRunner } from "./heavyQueue.ts";

/** Which notices the server sends. */
export const HeavyNoticesMode = Schema.Literals(["unexpected", "every-move", "problems", "off"]);
export type HeavyNoticesMode = typeof HeavyNoticesMode.Type;

export const HEAVY_NOTICES_MODE_OPTIONS: ReadonlyArray<{
  readonly value: HeavyNoticesMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "unexpected",
    label: "Problems and unexpected moves",
    description: "Failures, Linux going offline, and jobs that ran somewhere you did not pick.",
  },
  {
    value: "every-move",
    label: "Every machine change",
    description: "Also Hybrid sending a job to Linux.",
  },
  { value: "problems", label: "Problems only", description: "Failures and Linux going offline." },
  { value: "off", label: "Off", description: "No heavy job notices." },
];

/**
 * One toast. A later notice with the same `id` replaces it: grouped jobs grow its count instead of
 * adding toasts.
 */
export const HeavyNotice = Schema.Struct({
  id: Schema.String,
  tone: Schema.Literals(["error", "warning", "info"]),
  title: Schema.String,
  description: Schema.String,
  machine: HeavyRunner,
  /** The job's agent thread, when the notice is about one job that has one. */
  threadId: Schema.NullOr(Schema.String),
});
export type HeavyNotice = typeof HeavyNotice.Type;

/** The notices one queue tick produced or updated. */
export const HeavyNoticeBatch = Schema.Array(HeavyNotice);
export type HeavyNoticeBatch = typeof HeavyNoticeBatch.Type;
