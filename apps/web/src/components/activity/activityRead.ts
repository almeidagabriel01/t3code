import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarPriorityRank } from "../Sidebar.logic";

type ActivityRow = Parameters<typeof resolveSidebarPriorityRank>[0]["thread"] &
  Pick<SidebarThreadSummary, "environmentId" | "id">;

export interface ActivityReadPlan<T> {
  readonly markRead: readonly T[];
  readonly releaseKeys: readonly string[];
}

/**
 * Clear read takes every finished row off the page: rows held only because it stayed
 * open, and unread completions or wakes this connection can mark read. Work in progress and
 * pending requests stay. Wakes are the ones the page ranked the row with.
 */
export function selectActivityClear<T extends ActivityRow>(input: {
  readonly threads: readonly T[];
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly wokeAtByKey: ReadonlyMap<string, string | null>;
  readonly canOperate: (thread: T) => boolean;
}): ActivityReadPlan<T> {
  const markRead: T[] = [];
  const releaseKeys: string[] = [];
  for (const thread of input.threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const rank = resolveSidebarPriorityRank({
      thread,
      localLastVisitedAt: input.localLastVisitedAtByKey[key],
      wokeAt: input.wokeAtByKey.get(key) ?? null,
    });
    if (rank === null) {
      releaseKeys.push(key);
    } else if (rank === 2 && input.canOperate(thread)) {
      markRead.push(thread);
      releaseKeys.push(key);
    }
  }
  return { markRead, releaseKeys };
}

/** Rows leave the page at once; a row whose visit fails comes back. */
export async function markActivityRead<T extends ActivityRow>(input: {
  readonly plan: ActivityReadPlan<T>;
  readonly release: (keys: readonly string[]) => void;
  readonly restore: (key: string) => void;
  readonly visit: (thread: T) => Promise<"visited" | "skipped" | "failed">;
}): Promise<void> {
  input.release(input.plan.releaseKeys);
  for (const thread of input.plan.markRead) {
    if ((await input.visit(thread)) === "failed") {
      input.restore(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
    }
  }
}
