import type { AssistantTask } from "@t3tools/contracts";

import {
  assistantTaskStatusOf,
  type AssistantTaskStatus,
} from "@t3tools/shared/assistantTaskStatus";

import type { assistantPresence, AssistantFace } from "./assistantRobot.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import { effectiveSnoozed } from "./state/threadSettled.ts";
import {
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
  type SettledThreadTimestampInput,
} from "./state/threadSort.ts";

type SectionShell = SettledThreadTimestampInput &
  Parameters<typeof effectiveSnoozed>[0] &
  Pick<EnvironmentThreadShell, "settledOverride" | "pinnedAt" | "pinOrderKey" | "createdAt">;

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
  /** Pinned threads, in their pin order, above the rest as a project's Pinned shelf. */
  readonly pinned: ReadonlyArray<AssistantTaskRow<S>>;
  /** Ordered by the caller's project-list sort, so the rows rank as its project rows do. */
  readonly open: ReadonlyArray<AssistantTaskRow<S>>;
  /** Snoozed threads, soonest wake first, as a project's Snoozed shelf. */
  readonly snoozed: ReadonlyArray<AssistantTaskRow<S>>;
  /** Threads the server settled (finished and seen), newest first, as a project's Settled shelf. */
  readonly settled: ReadonlyArray<AssistantTaskRow<S>>;
}

/**
 * An assistant's task rows split as a project splits its threads: snooze wins until its wake time,
 * then settlement, then a pin. Dismissed tasks, deleted threads and archived threads drop out.
 */
export function assistantTaskRows<S extends TaskShell & SectionShell>(
  tasks: ReadonlyArray<AssistantTask>,
  shellOf: (threadId: string) => S | null | undefined,
  sortOpen: (shells: ReadonlyArray<S>) => ReadonlyArray<S>,
  options: { readonly now: string },
): AssistantTaskSections<S> {
  const rowByShell = new Map<S, AssistantTaskRow<S>>();
  for (const task of tasks) {
    if (task.dismissedAt != null) continue;
    const shell = shellOf(task.threadId);
    if (shell == null || shell.archivedAt != null) continue;
    rowByShell.set(shell, { task, shell, state: assistantTaskState(shell) });
  }
  const pinned: S[] = [];
  const open: S[] = [];
  const snoozed: S[] = [];
  const settled: S[] = [];
  for (const shell of rowByShell.keys()) {
    if (effectiveSnoozed(shell, options)) snoozed.push(shell);
    else if (shell.settledOverride === "settled") settled.push(shell);
    else if (shell.pinnedAt != null) pinned.push(shell);
    else open.push(shell);
  }
  const rowsOf = (ordered: ReadonlyArray<S>) => ordered.map((shell) => rowByShell.get(shell)!);
  return {
    pinned: rowsOf(sortPinnedThreadsByOrderKey(pinned)),
    open: rowsOf(sortOpen(open)),
    snoozed: rowsOf(
      [...snoozed].sort((a, b) => Date.parse(a.snoozedUntil!) - Date.parse(b.snoozedUntil!)),
    ),
    settled: rowsOf(sortSettledThreads(settled)),
  };
}

export interface AssistantSectionRows {
  /** The assistant's own chat; null before its thread exists. */
  readonly chatKey: string | null;
  readonly folded: boolean;
  readonly sections: AssistantTaskSections<TaskShell & { readonly environmentId: string }>;
  readonly snoozedOpen: boolean;
  readonly settledOpen: boolean;
  readonly subagentKeys: ReadonlyArray<string>;
}

/**
 * The thread keys the assistants section shows, in render order, so ⌘1–9 numbers its rows from the
 * same list the sidebar draws: each chat, then its unfolded tasks shelf by shelf, then its subagents.
 */
export function assistantSectionThreadKeys(
  assistants: ReadonlyArray<AssistantSectionRows>,
): ReadonlyArray<string> {
  const keys: string[] = [];
  const add = (
    rows: ReadonlyArray<AssistantTaskRow<TaskShell & { readonly environmentId: string }>>,
  ) => {
    for (const { shell } of rows) keys.push(`${shell.environmentId}:${shell.id}`);
  };
  for (const assistant of assistants) {
    if (assistant.chatKey !== null) keys.push(assistant.chatKey);
    if (assistant.folded) continue;
    add(assistant.sections.pinned);
    add(assistant.sections.open);
    if (assistant.snoozedOpen) add(assistant.sections.snoozed);
    if (assistant.settledOpen) add(assistant.sections.settled);
    keys.push(...assistant.subagentKeys);
  }
  return keys;
}
