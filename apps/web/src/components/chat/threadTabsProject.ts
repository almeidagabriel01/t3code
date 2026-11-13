import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isAssistantThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import { readThreadShell } from "../../state/entities";
import { threadTabsWorkspaceKey, useThreadTabsStore } from "../../threadTabsStore";

/**
 * A thread's tabs open in its project's workspace. Assistant conversations and side chats live outside project lists, so
 * they open without tabs.
 */
export function threadTabsProjectKey(
  shell: Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "id" | "lineage"> | null,
): string | null {
  if (!shell || isAssistantThreadId(shell.id) || shell.lineage.sideChat === true) return null;
  return `${shell.environmentId}:${shell.projectId}`;
}

export function threadKeyProject(threadKey: string): string | null {
  const ref = parseScopedThreadKey(threadKey);
  return threadTabsProjectKey(ref ? readThreadShell(ref) : null);
}

/** The workspace the thread's tab lives in, or would open in; see `threadTabPlacement`. */
export function readThreadTabsProjectKey(ref: ScopedThreadRef | null): string | null {
  if (ref === null) return null;
  return threadTabsWorkspaceKey(
    useThreadTabsStore.getState(),
    scopedThreadKey(ref),
    threadTabsProjectKey(readThreadShell(ref)),
    threadKeyProject,
  );
}
