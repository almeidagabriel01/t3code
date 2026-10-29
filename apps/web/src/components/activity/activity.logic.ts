import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";

import {
  filterSidebarV2VisibleThreads,
  holdSidebarPriorityRank,
  resolveSidebarPriorityRank,
  sortPriorityThreadsForSidebar,
  type SidebarPriorityHolds,
} from "../Sidebar.logic";

/** 0 needs the user, 1 is working, 2 finished unseen or woke. */
export type ActivityRank = 0 | 1 | 2;

export interface ActivityEntry {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly rank: ActivityRank;
}

const threadActivityKey = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * Archived, side-chat, delegated and snoozed threads stay off the page. Held rows keep their
 * place as unread after a visit, so the thread being read does not vanish from the list.
 */
export function buildActivityEntries(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly holds: SidebarPriorityHolds;
  readonly releases: ReadonlySet<string>;
  readonly now: string;
}): ActivityEntry[] {
  const ranks = new Map<string, ActivityRank>();
  const listed: EnvironmentThreadShell[] = [];
  for (const thread of filterSidebarV2VisibleThreads(
    input.threads,
    null,
    input.delegatedUnderParent,
  )) {
    if (effectiveSnoozed(thread, { now: input.now })) continue;
    const key = threadActivityKey(thread);
    const rank = holdSidebarPriorityRank({
      rank: resolveSidebarPriorityRank({
        thread,
        localLastVisitedAt: input.localLastVisitedAtByKey[key],
        wokeAt: threadWokeAt(thread, { now: input.now }),
      }),
      key,
      settledOverride: thread.settledOverride,
      holds: input.holds,
      released: input.releases.has(key),
    });
    if (rank === null) continue;
    ranks.set(key, rank);
    listed.push(thread);
  }
  return sortPriorityThreadsForSidebar(listed, ranks).map((thread) => {
    const key = threadActivityKey(thread);
    return { key, thread, rank: ranks.get(key) ?? 2 };
  });
}

/** What the bell and rail badge show: threads that need the user, or finished unseen. */
export function countActivityBadge(entries: readonly ActivityEntry[]): number {
  return entries.filter((entry) => entry.rank !== 1).length;
}
