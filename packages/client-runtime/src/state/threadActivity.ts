import { isAssistantThreadId, isSideChatThread } from "@t3tools/contracts";
import { guestWaitsOnUser } from "@t3tools/shared/needsUser";

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
  /** Something on the row arrived after the user last looked; a held row is already read. */
  readonly unread: boolean;
  /**
   * The row's newest arrival. Visiting at it reads the row without trusting this device's
   * clock, which can lag the machine that ran the thread. Null when the row has no time.
   */
  readonly readAt: string | null;
}

const newestTimestamp = (...candidates: ReadonlyArray<string | null | undefined>) => {
  let newest: string | null = null;
  for (const candidate of candidates) {
    if (candidate == null || Number.isNaN(Date.parse(candidate))) continue;
    if (newest === null || Date.parse(candidate) > Date.parse(newest)) newest = candidate;
  }
  return newest;
};

/**
 * When the newest thing a row needs the user for arrived. Null when any cause has no time,
 * as from older servers, so the row keeps counting until it is answered.
 */
function activityNeedsYouSince(
  thread: ThreadStatusInput &
    Pick<
      EnvironmentThreadShell,
      | "pendingRequest"
      | "pendingUserInputAt"
      | "pendingSubagentRequestAt"
      | "latestPendingGuestMessageAt"
    >,
  openDecisionAt: string | null | undefined,
): string | null {
  const causes: Array<string | null | undefined> = [];
  if (thread.hasPendingApprovals) causes.push(thread.pendingRequest?.createdAt);
  if (thread.hasPendingUserInput) causes.push(thread.pendingUserInputAt);
  if (thread.pendingSubagentRequest != null) causes.push(thread.pendingSubagentRequestAt);
  if (guestWaitsOnUser(thread)) causes.push(thread.latestPendingGuestMessageAt);
  if (openDecisionAt !== undefined) causes.push(openDecisionAt);
  if (causes.some((at) => at == null || Number.isNaN(Date.parse(at)))) return null;
  return newestTimestamp(...causes);
}

const seenSince = (since: string | null, lastVisitedAt: string | undefined) => {
  if (since === null || lastVisitedAt === undefined) return false;
  const visited = Date.parse(lastVisitedAt);
  return Number.isFinite(visited) && visited >= Date.parse(since);
};

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
  /** When each thread's newest open decision arrived; see `openDecisionAtByThreadKey`. */
  readonly openDecisionAtByKey?: ReadonlyMap<string, string> | undefined;
}): ActivityEntry[] {
  const ranks = new Map<string, ActivityRank>();
  const reads = new Map<string, Pick<ActivityEntry, "unread" | "readAt">>();
  const listed: EnvironmentThreadShell[] = [];
  for (const thread of filterSidebarV2VisibleThreads(
    input.threads,
    null,
    input.delegatedUnderParent,
  )) {
    if (effectiveSnoozed(thread, { now: input.now })) continue;
    const key = threadActivityKey(thread);
    const wokeAt = threadWokeAt(thread, { now: input.now });
    const hasOpenDecision = input.openDecisionThreadKeys?.has(key) === true;
    const liveRank = resolveSidebarPriorityRank({
      thread,
      localLastVisitedAt: input.localLastVisitedAtByKey[key],
      wokeAt,
      hasOpenDecision,
    });
    const rank = holdSidebarPriorityRank({
      rank: liveRank,
      key,
      settledOverride: thread.settledOverride,
      holds: input.holds,
      released: input.releases.has(key),
    });
    if (rank === null) continue;
    ranks.set(key, rank);
    listed.push(thread);
    const lastVisitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      input.localLastVisitedAtByKey[key],
    );
    const since =
      liveRank === 0
        ? activityNeedsYouSince(
            thread,
            hasOpenDecision ? (input.openDecisionAtByKey?.get(key) ?? null) : undefined,
          )
        : null;
    const finishedUnseen =
      hasUnseenCompletion({ ...thread, lastVisitedAt }) ||
      isSidebarThreadWoke(wokeAt, lastVisitedAt);
    reads.set(key, {
      unread:
        liveRank === 2 || (liveRank === 0 && (!seenSince(since, lastVisitedAt) || finishedUnseen)),
      readAt:
        liveRank === 0 && since === null
          ? null
          : newestTimestamp(since, thread.latestRun?.completedAt, wokeAt),
    });
  }
  return sortPriorityThreadsForSidebar(listed, ranks).map((thread) => {
    const key = threadActivityKey(thread);
    return {
      key,
      thread,
      rank: ranks.get(key) ?? 2,
      ...(reads.get(key) ?? { unread: false, readAt: null }),
    };
  });
}

/**
 * Whether a row counts in the bell and rail badges. A row on a connection that cannot mark it
 * read shows without counting, so Mark all as read can always clear the badge.
 */
export function countsInActivityBadge(
  entry: Pick<ActivityEntry, "rank" | "unread">,
  operable: boolean,
): boolean {
  return entry.rank !== 1 && entry.unread && operable;
}

/** What the bell and rail badge show: rows that need the user or finished since they last looked. */
export function countActivityBadge(
  entries: readonly ActivityEntry[],
  canOperate: (thread: EnvironmentThreadShell) => boolean = () => true,
): number {
  return entries.filter((entry) => countsInActivityBadge(entry, canOperate(entry.thread))).length;
}

export interface AgentsSectionEntry extends ActivityEntry {
  /** Run start for working rows, run completion for finished ones; null when the shell has none. */
  readonly at: string | null;
}

const ownedByAssistant = (entry: ActivityEntry, assistantTaskKeys: ReadonlySet<string>) =>
  assistantTaskKeys.has(entry.key) ||
  isAssistantThreadId(entry.thread.lineage.parentThreadId ?? "") ||
  isAssistantThreadId(entry.thread.delegatedFrom?.threadId ?? "");

/**
 * The sidebar's Agents section: Activity's rows by rank, newest first in each group. Threads an
 * assistant owns (its launched tasks, by thread key, and its chats' children) are listed under it.
 */
export function selectAgentsSection(
  entries: readonly ActivityEntry[],
  assistantTaskKeys: ReadonlySet<string> = new Set(),
): {
  readonly needsYou: AgentsSectionEntry[];
  readonly working: AgentsSectionEntry[];
  readonly done: AgentsSectionEntry[];
} {
  const stamped = (rank: ActivityRank, pick: (entry: ActivityEntry) => string | null) =>
    entries
      .filter((entry) => entry.rank === rank && !ownedByAssistant(entry, assistantTaskKeys))
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

export type ProjectActivityOutcome = "needs-you" | "failed" | "interrupted" | "finished";

export interface ProjectActivityEntry extends AgentsSectionEntry {
  readonly outcome: ProjectActivityOutcome;
}

/**
 * One project's slice of Activity: runs waiting on the user and runs that ended unseen,
 * newest first. Work in progress stays in the sidebar's Agents section.
 */
export function selectProjectActivity(
  entries: readonly ActivityEntry[],
  project: { readonly environmentId: string; readonly projectId: string },
): ProjectActivityEntry[] {
  const { needsYou, done } = selectAgentsSection(
    entries.filter(
      ({ thread }) =>
        thread.environmentId === project.environmentId && thread.projectId === project.projectId,
    ),
  );
  const ended = (entry: AgentsSectionEntry): ProjectActivityOutcome =>
    entry.thread.latestRun?.status === "failed"
      ? "failed"
      : entry.thread.latestRun?.status === "interrupted"
        ? "interrupted"
        : "finished";
  return [
    ...needsYou.map((entry) => ({ ...entry, outcome: "needs-you" as const })),
    ...done.map((entry) => ({ ...entry, outcome: ended(entry) })),
  ].sort((left, right) => firstValidTimestampMs(right.at) - firstValidTimestampMs(left.at));
}

interface ActivityVisit {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly visitedAt: string;
}

export interface ActivityReadPlan {
  readonly visits: readonly ActivityVisit[];
  readonly releaseKeys: readonly string[];
}

const visitOf = (entry: ActivityEntry, now: string): ActivityVisit => ({
  key: entry.key,
  thread: entry.thread,
  visitedAt: entry.readAt ?? now,
});

/**
 * Mark all as read visits every row the badge counts. Requests stay listed until answered or
 * dismissed; finished rows leave.
 */
export function planActivityMarkAllRead(
  entries: readonly ActivityEntry[],
  canOperate: (thread: EnvironmentThreadShell) => boolean,
  now: string,
): ActivityReadPlan {
  const visits = entries
    .filter((entry) => countsInActivityBadge(entry, canOperate(entry.thread)))
    .map((entry) => visitOf(entry, now));
  return { visits, releaseKeys: visits.map((visit) => visit.key) };
}

/**
 * Clear read takes finished rows off the page, all of them or the one `onlyKey` names: rows held
 * only because the page stayed open, and unread ones this connection can mark read. Work in
 * progress and requests stay, as do unread rows a read-only connection cannot clear.
 */
export function planActivityClear(
  entries: readonly ActivityEntry[],
  canOperate: (thread: EnvironmentThreadShell) => boolean,
  now: string,
  onlyKey?: string,
): ActivityReadPlan {
  const visits: ActivityVisit[] = [];
  const releaseKeys: string[] = [];
  for (const entry of entries) {
    if (entry.rank !== 2 || (onlyKey !== undefined && entry.key !== onlyKey)) continue;
    if (!entry.unread) {
      releaseKeys.push(entry.key);
    } else if (canOperate(entry.thread)) {
      visits.push(visitOf(entry, now));
      releaseKeys.push(entry.key);
    }
  }
  return { visits, releaseKeys };
}

/** Rows leave the page at once; a row whose visit fails comes back. */
export async function markActivityRead(input: {
  readonly plan: ActivityReadPlan;
  readonly release: (keys: readonly string[]) => void;
  readonly restore: (key: string) => void;
  readonly visit: (
    thread: EnvironmentThreadShell,
    visitedAt: string,
  ) => Promise<"visited" | "skipped" | "failed">;
}): Promise<void> {
  input.release(input.plan.releaseKeys);
  for (const { key, thread, visitedAt } of input.plan.visits) {
    if ((await input.visit(thread, visitedAt)) === "failed") input.restore(key);
  }
}
