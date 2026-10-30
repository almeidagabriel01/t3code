import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";

export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

type ThreadStatusFields = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
>;

export function resolveSidebarThreadStatus(thread: ThreadStatusFields): SidebarThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

type ThreadAttentionFields = Pick<
  EnvironmentThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "latestRun"
> & {
  readonly lastVisitedAt?: string | null | undefined;
  /** An agent in this thread is waiting on the user's answer to a decision. */
  readonly hasOpenDecision?: boolean | undefined;
};

export function hasUnseenCompletion(thread: ThreadAttentionFields): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Unopened threads' failures still count as unseen, unlike completions. */
export function hasUnseenFailure(thread: ThreadAttentionFields): boolean {
  if (thread.latestRun?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Whether a thread needs the user: a pending request, or a failure or completion not yet opened. */
export function hasSidebarNotification(thread: ThreadAttentionFields): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null ||
    thread.hasOpenDecision === true ||
    hasUnseenFailure(thread) ||
    hasUnseenCompletion(thread)
  );
}

function isActiveSubagentChild(thread: EnvironmentThreadShell): boolean {
  if (thread.archivedAt !== null) return false;
  const status = resolveSidebarThreadStatus(thread);
  return (
    status === "working" ||
    status === "approval" ||
    status === "input" ||
    status === "request" ||
    (status === "waiting" && thread.runtime?.status === "running")
  );
}

/** Non-terminal subagent children by parent thread key, oldest first. */
export function activeSubagentChildrenByParent(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyMap<string, readonly EnvironmentThreadShell[]> {
  const byParent = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    const parentId = thread.lineage.parentThreadId;
    if (
      thread.lineage.relationshipToParent !== "subagent" ||
      parentId === null ||
      !isActiveSubagentChild(thread)
    ) {
      continue;
    }
    const parentKey = scopedThreadKey(scopeThreadRef(thread.environmentId, parentId));
    const children = byParent.get(parentKey);
    if (children === undefined) byParent.set(parentKey, [thread]);
    else children.push(thread);
  }
  for (const children of byParent.values()) {
    children.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return byParent;
}
