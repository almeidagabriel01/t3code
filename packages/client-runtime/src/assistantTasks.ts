import type { AssistantTask } from "@t3tools/contracts";

import {
  assistantTaskStatusOf,
  type AssistantTaskStatus,
} from "@t3tools/shared/assistantTaskStatus";

import type { assistantPresence, AssistantFace } from "./assistantRobot.ts";

/** What a task row says, read from the task thread's own shell. */
export type AssistantTaskState = AssistantTaskStatus | "usage_limited";

export const ASSISTANT_TASK_STATE_LABEL: Record<AssistantTaskState, string> = {
  running: "Running",
  waiting: "Waiting",
  usage_limited: "Usage limit",
  done: "Done",
  failed: "Failed",
};

/** "Limit until <time>" while the reset is ahead, else null; `formatAt` is the platform's upcoming-time format. */
export function usageLimitLabel(
  resetAt: string | null | undefined,
  nowMs: number,
  formatAt: (iso: string) => string,
): string | null {
  return resetAt != null && Date.parse(resetAt) > nowMs ? `Limit until ${formatAt(resetAt)}` : null;
}

type TaskShell = NonNullable<Parameters<typeof assistantPresence>[0]> & {
  readonly id: string;
  readonly title: string;
  readonly archivedAt?: string | null;
};

/** The robot's face for a state, so a task thread wears its assistant's look and mood. */
export const ASSISTANT_TASK_FACE: Record<AssistantTaskState, AssistantFace> = {
  running: "working",
  waiting: "waiting",
  usage_limited: "waiting",
  failed: "failed",
  done: "done",
};

export function assistantTaskState(shell: TaskShell): AssistantTaskState {
  const status = assistantTaskStatusOf({
    needsUser:
      shell.hasPendingApprovals ||
      shell.hasPendingUserInput ||
      shell.pendingSubagentRequest != null ||
      (shell.pendingGuestMessageCount ?? 0) > 0,
    runtimeStatus: shell.runtime?.status ?? null,
  });
  // A usage limit waits for its reset or a provider switch, which runs the same thread again.
  return status === "failed" && shell.runtime?.lastErrorClass === "usage_limit"
    ? "usage_limited"
    : status;
}

/** A task whose thread still runs or waits on the user keeps its row; the server refuses it too. */
export const canDismissAssistantTask = (state: AssistantTaskState) =>
  state === "done" || state === "failed" || state === "usage_limited";

/** What a thread menu needs of a thread's task link; null when the thread is no task. */
export function assistantTaskMenuState(
  task: AssistantTask | null | undefined,
  shell: TaskShell | null | undefined,
): { readonly dismissed: boolean; readonly canDismiss: boolean } | null {
  if (task == null) return null;
  return {
    dismissed: task.dismissedAt != null,
    canDismiss: shell != null && canDismissAssistantTask(assistantTaskState(shell)),
  };
}

export interface AssistantTaskRow<S extends TaskShell> {
  readonly task: AssistantTask;
  readonly shell: S;
  readonly state: AssistantTaskState;
}

const ORDER: Record<AssistantTaskState, number> = {
  waiting: 0,
  running: 1,
  usage_limited: 2,
  failed: 3,
  done: 4,
};

/**
 * An assistant's tasks that still have a thread and were not dismissed, waiting first, then
 * running, usage-limited, failed and done, each newest first. A deleted thread drops out; an archived one stays hidden once it is done.
 */
export function assistantTaskRows<S extends TaskShell>(
  tasks: ReadonlyArray<AssistantTask>,
  shellOf: (threadId: string) => S | null | undefined,
): Array<AssistantTaskRow<S>> {
  const rows: Array<AssistantTaskRow<S>> = [];
  for (const task of tasks) {
    if (task.dismissedAt != null) continue;
    const shell = shellOf(task.threadId);
    if (shell === null || shell === undefined) continue;
    rows.push({ task, shell, state: assistantTaskState(shell) });
  }
  return rows
    .filter((row) => row.shell.archivedAt == null || row.state !== "done")
    .sort(
      (left, right) =>
        ORDER[left.state] - ORDER[right.state] ||
        right.task.createdAt.localeCompare(left.task.createdAt) ||
        left.task.threadId.localeCompare(right.task.threadId),
    );
}
