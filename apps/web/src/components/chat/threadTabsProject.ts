import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isAssistantThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import { readThreadShell } from "../../state/entities";

/**
 * Tabs are per project. Assistant conversations and side chats live outside project lists, so
 * they open without tabs.
 */
export function threadTabsProjectKey(
  shell: Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "id" | "lineage"> | null,
): string | null {
  if (!shell || isAssistantThreadId(shell.id) || shell.lineage.sideChat === true) return null;
  return `${shell.environmentId}:${shell.projectId}`;
}

export function readThreadTabsProjectKey(ref: ScopedThreadRef | null): string | null {
  return threadTabsProjectKey(ref ? readThreadShell(ref) : null);
}
