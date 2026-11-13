import type { AssistantTask } from "@t3tools/contracts";

import {
  assistantTaskStatusOf,
  type AssistantTaskStatus,
} from "@t3tools/shared/assistantTaskStatus";

import type { assistantPresence, AssistantFace } from "./assistantRobot.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import { sortSettledThreads, type SettledThreadTimestampInput } from "./state/threadSort.ts";

type SettledShell = SettledThreadTimestampInput & Pick<EnvironmentThreadShell, "settledOverride">;

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

export interface AssistantTaskSections<S extends TaskShell> {
  /** Ordered by the caller's project-list sort, so the rows rank as its project rows do. */
  readonly open: ReadonlyArray<AssistantTaskRow<S>>;
  /** Threads the server settled (finished and seen), newest first, as a project's Settled shelf. */
  readonly settled: ReadonlyArray<AssistantTaskRow<S>>;
}

/**
 * An assistant's task rows split as a project splits its threads. Dismissed tasks, deleted threads
 * and archived threads drop out, as archived threads leave project lists.
 */
export function assistantTaskRows<S extends TaskShell & SettledShell>(
  tasks: ReadonlyArray<AssistantTask>,
  shellOf: (threadId: string) => S | null | undefined,
  sortOpen: (shells: ReadonlyArray<S>) => ReadonlyArray<S>,
): AssistantTaskSections<S> {
  const rowByShell = new Map<S, AssistantTaskRow<S>>();
  for (const task of tasks) {
    if (task.dismissedAt != null) continue;
    const shell = shellOf(task.threadId);
    if (shell == null || shell.archivedAt != null) continue;
    rowByShell.set(shell, { task, shell, state: assistantTaskState(shell) });
  }
  const shells = [...rowByShell.keys()];
  const rowsOf = (ordered: ReadonlyArray<S>) => ordered.map((shell) => rowByShell.get(shell)!);
  return {
    open: rowsOf(sortOpen(shells.filter((shell) => shell.settledOverride !== "settled"))),
    settled: rowsOf(
      sortSettledThreads(shells.filter((shell) => shell.settledOverride === "settled")),
    ),
  };
}
