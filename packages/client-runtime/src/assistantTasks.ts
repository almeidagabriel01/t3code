import type { AssistantTask } from "@t3tools/contracts";

import {
  assistantTaskStatusOf,
  type AssistantTaskStatus,
} from "@t3tools/shared/assistantTaskStatus";

import type { assistantPresence, AssistantFace } from "./assistantRobot.ts";

/** What a task row says, read from the task thread's own shell. */
export type AssistantTaskState = AssistantTaskStatus;

export const ASSISTANT_TASK_STATE_LABEL: Record<AssistantTaskState, string> = {
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
};

type TaskShell = NonNullable<Parameters<typeof assistantPresence>[0]> & {
  readonly id: string;
  readonly title: string;
  readonly archivedAt?: string | null;
};

/** The robot's face for a state, so a task thread wears its assistant's look and mood. */
export const ASSISTANT_TASK_FACE: Record<AssistantTaskState, AssistantFace> = {
  running: "working",
  waiting: "waiting",
  failed: "failed",
  done: "done",
};

export function assistantTaskState(shell: TaskShell): AssistantTaskState {
  return assistantTaskStatusOf({
    needsUser:
      shell.hasPendingApprovals ||
      shell.hasPendingUserInput ||
      shell.pendingSubagentRequest != null ||
      (shell.pendingGuestMessageCount ?? 0) > 0,
    runtimeStatus: shell.runtime?.status ?? null,
  });
}

/** A task whose thread still runs or waits on the user keeps its row; the server refuses it too. */
export const canDismissAssistantTask = (state: AssistantTaskState) =>
  state === "done" || state === "failed";

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

const ORDER: Record<AssistantTaskState, number> = { waiting: 0, running: 1, failed: 2, done: 3 };

/**
 * An assistant's tasks that still have a thread and were not dismissed, waiting first, then running, failed and done,
 * each newest first. A deleted thread drops out; an archived one stays hidden once it is done.
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
