import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

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
