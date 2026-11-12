import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type KanbanPanelThreadState = "attention" | "running" | "idle";

/** What a linked thread's dot shows; null when the thread is not loaded here. */
export function kanbanPanelThreadState(
  shell: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime"
  > | null,
  isActive: (runtime: EnvironmentThreadShell["runtime"]) => boolean,
): KanbanPanelThreadState | null {
  if (shell === null) return null;
  if (shell.hasPendingApprovals || shell.hasPendingUserInput || shell.pendingSubagentRequest) {
    return "attention";
  }
  return isActive(shell.runtime) ? "running" : "idle";
}
