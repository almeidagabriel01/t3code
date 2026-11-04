import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { buildActivityEntries } from "@t3tools/client-runtime/state/thread-activity";

const NO_DELEGATED: ReadonlySet<string> = new Set();
const NO_HOLDS = new Map<string, never>();

/** Activity's rows as Home shows them: no holds, so a read thread leaves at once. */
export function buildHomeActivityEntries(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly openDecisionThreadKeys: ReadonlySet<string>;
}) {
  return buildActivityEntries({
    // Older servers keep no visit time, so a finished run would never clear.
    threads: input.threads.map((thread) =>
      thread.lastVisitedAt === undefined ? { ...thread, latestRun: null } : thread,
    ),
    delegatedUnderParent: NO_DELEGATED,
    localLastVisitedAtByKey: {},
    holds: NO_HOLDS,
    releases: NO_DELEGATED,
    now: input.now,
    openDecisionThreadKeys: input.openDecisionThreadKeys,
  });
}
