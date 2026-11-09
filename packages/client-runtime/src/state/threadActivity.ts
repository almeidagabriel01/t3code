import { isAssistantThreadId, isSideChatThread } from "@t3tools/contracts";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "./threadAttention.ts";
import { effectiveSnoozed, threadWokeAt } from "./threadSettled.ts";
import { isShownUnderParent } from "./threads.ts";

type SidebarThreadSummary = EnvironmentThreadShell;

/**
 * `delegatedUnderParent` holds the tasks linked environments run for a thread
 * the sidebar lists, by thread key; they show under that thread, as subagents do.
 */
export function filterSidebarV2VisibleThreads<
  T extends Pick<
    SidebarThreadSummary,
    "archivedAt" | "environmentId" | "id" | "lineage" | "sideChatOf"
  > & {
    projectId: string;
  },
>(
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string> | null,
  delegatedUnderParent: ReadonlySet<string>,
): T[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !isSideChatThread(thread) &&
      !isAssistantThreadId(thread.id) &&
      !isShownUnderParent(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.lineage,
        delegatedUnderParent,
      ) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
}

export type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: SidebarThreadSummary["pendingBackgroundTasks"] | undefined;
  blockedOnThreadWait?: boolean | undefined;
  /** An agent in this thread waits on the user's answer to a decision. */
  hasOpenDecision?: boolean | undefined;
};

export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // Server visits override local watermarks, including mark-unread rewinds; use local values only on older
  // servers.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

/** A visit acknowledges a wake without changing the thread's lifecycle. */
export function isSidebarThreadWoke(
  wokeAt: string | null,
  lastVisitedAt: string | undefined,
): boolean {
  if (wokeAt === null || !Number.isFinite(Date.parse(wokeAt))) return false;
  const visited = lastVisitedAt === undefined ? NaN : Date.parse(lastVisitedAt);
  return !Number.isFinite(visited) || visited < Date.parse(wokeAt);
}

/**
 * Priority is a display overlay; its rank never changes pinning or settlement. A subagent's
 * pending request already reaches its parent through `pendingSubagentRequest`.
 */
export function resolveSidebarPriorityRank(input: {
  readonly thread: ThreadStatusInput;
  readonly localLastVisitedAt?: string | undefined;
  readonly wokeAt: string | null;
  /** An agent waits on the user's answer to a decision, whatever else the thread is doing. */
  readonly hasOpenDecision?: boolean | undefined;
}): 0 | 1 | 2 | null {
  if (input.hasOpenDecision === true) return 0;
  const status = resolveSidebarThreadStatus({
    ...input.thread,
    blockedOnThreadWait: input.thread.blockedOnThreadWait === true,
  });
  // A guest waiting on the owner needs the user as much as an agent's own request does.
  if (status === "approval" || status === "input" || status === "request") return 0;
  if (status === "working" || status === "waiting") return 1;
  const lastVisitedAt = resolveThreadLastVisitedAt(
    input.thread.lastVisitedAt,
    input.localLastVisitedAt,
  );
  return hasUnseenCompletion({ ...input.thread, lastVisitedAt }) ||
    isSidebarThreadWoke(input.wokeAt, lastVisitedAt)
    ? 2
    : null;
}

/** Settled state each row had when the Activity page last showed it, by scoped thread key. */
export type SidebarPriorityHolds = ReadonlyMap<string, SidebarThreadSummary["settledOverride"]>;

/**
 * Reading a thread does not pull its row off the Activity page while it stays open; it leaves
 * when the page is opened again. Settling or unsettling the row is the user's own move, so a
 * changed settled state ends the hold.
 */
export function holdSidebarPriorityRank(input: {
  readonly rank: 0 | 1 | 2 | null;
  readonly key: string;
  readonly settledOverride: SidebarThreadSummary["settledOverride"];
  readonly holds: SidebarPriorityHolds;
  /** Mark all as read drops the row once it no longer qualifies, instead of holding it. */
  readonly released?: boolean;
}): 0 | 1 | 2 | null {
  if (input.released) return input.rank;
  if (input.rank !== null || !input.holds.has(input.key)) return input.rank;
  return input.holds.get(input.key) === input.settledOverride ? 2 : null;
}

/** Writable unread completions and woke-only rows are targets of Priority's bulk visit. */
export function selectSidebarMarkReadTargets<
  T extends ThreadStatusInput & Pick<SidebarThreadSummary, "environmentId" | "id">,
>(input: {
  readonly threads: readonly T[];
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly wokeAtByKey?: ReadonlyMap<string, string | null>;
  readonly canOperate: (thread: T) => boolean;
}): T[] {
  return input.threads.filter((thread) => {
    if (!input.canOperate(thread)) return false;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const lastVisitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      input.localLastVisitedAtByKey[key],
    );
    return (
      hasUnseenCompletion({ ...thread, lastVisitedAt }) ||
      isSidebarThreadWoke(input.wokeAtByKey?.get(key) ?? null, lastVisitedAt)
    );
  });
}

/**
 * Lowest rank first, then the thread the user prompted last (creation time when never
 * prompted). Streamed events move updatedAt, never the prompt time, so rows hold their
 * places while threads run. Wakes and agent messages also move latestUserMessageAt, so it
 * stands in only for servers that send no authored time.
 */
export function sortPriorityThreadsForSidebar<
  T extends Pick<SidebarThreadSummary, "environmentId" | "id" | "createdAt"> & {
    readonly latestUserMessageAt?: string | null | undefined;
    readonly latestUserAuthoredMessageAt?: string | null | undefined;
  },
>(threads: readonly T[], ranks: ReadonlyMap<string, number>): T[] {
  const key = (thread: T) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const promptAt = (thread: T) =>
    Math.max(
      firstValidTimestampMs(thread.createdAt),
      firstValidTimestampMs(
        thread.latestUserAuthoredMessageAt === undefined
          ? thread.latestUserMessageAt
          : thread.latestUserAuthoredMessageAt,
      ),
    );
  return [...threads].sort(
    (left, right) =>
      (ranks.get(key(left)) ?? 2) - (ranks.get(key(right)) ?? 2) ||
      promptAt(right) - promptAt(left) ||
      key(left).localeCompare(key(right)),
  );
}

export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

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
  /** Scoped thread keys with an open decision; see `openDecisionThreadKeys`. */
  readonly openDecisionThreadKeys?: ReadonlySet<string> | undefined;
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
        hasOpenDecision: input.openDecisionThreadKeys?.has(key),
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

export interface AgentsSectionEntry extends ActivityEntry {
  /** Run start for working rows, run completion for finished ones; null when the shell has none. */
  readonly at: string | null;
}

/** The sidebar's Agents section: Activity's rows by rank, newest first in each group. */
export function selectAgentsSection(entries: readonly ActivityEntry[]): {
  readonly needsYou: AgentsSectionEntry[];
  readonly working: AgentsSectionEntry[];
  readonly done: AgentsSectionEntry[];
} {
  const stamped = (rank: ActivityRank, pick: (entry: ActivityEntry) => string | null) =>
    entries
      .filter((entry) => entry.rank === rank)
      .map((entry): AgentsSectionEntry => ({ ...entry, at: pick(entry) }))
      .sort((left, right) => firstValidTimestampMs(right.at) - firstValidTimestampMs(left.at));
  return {
    needsYou: stamped(0, ({ thread }) => thread.updatedAt ?? thread.latestRun?.startedAt ?? null),
    working: stamped(
      1,
      ({ thread }) =>
        thread.latestRun?.startedAt ?? thread.latestRun?.requestedAt ?? thread.createdAt,
    ),
    done: stamped(2, ({ thread }) => thread.latestRun?.completedAt ?? thread.updatedAt ?? null),
  };
}

export interface ActivityReadPlan<T> {
  readonly markRead: readonly T[];
  readonly releaseKeys: readonly string[];
}

/**
 * Clear read takes every finished row off the page: rows held only because it stayed
 * open, and unread completions or wakes this connection can mark read. Work in progress and
 * pending requests stay. Wakes are the ones the page ranked the row with.
 */
export function selectActivityClear<
  T extends ThreadStatusInput & Pick<SidebarThreadSummary, "environmentId" | "id">,
>(input: {
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
export async function markActivityRead<
  T extends ThreadStatusInput & Pick<SidebarThreadSummary, "environmentId" | "id">,
>(input: {
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
