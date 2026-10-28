import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadRuntimeIsActive,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** "attention" is a pending approval, question, or guest request: the thread needs the user. */
export type RunningThreadState = "running" | "attention";

type RunningShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "pendingBackgroundTasks"
  | "archivedAt"
  | "deletedAt"
  | "createdAt"
>;

/**
 * Subagents count, since the page shows all work in flight; archived and deleted threads do
 * not. A run parked at idle while its background work holds completion still counts as running.
 */
export function classifyRunningThread(
  shell: Omit<RunningShell, "environmentId" | "id" | "projectId" | "title" | "createdAt">,
): RunningThreadState | null {
  if (shell.archivedAt !== null || shell.deletedAt !== null) return null;
  if (
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput ||
    (shell.pendingSubagentRequest ?? null) !== null ||
    (shell.pendingGuestMessageCount ?? 0) > 0
  ) {
    return "attention";
  }
  if (threadRuntimeIsActive(shell.runtime)) return "running";
  if (shell.runtime?.status === "idle" && shell.pendingBackgroundTasks.length > 0) {
    return "running";
  }
  return null;
}

export interface RunningSummary {
  readonly running: number;
  readonly attention: number;
}

export function summarizeRunning(shells: ReadonlyArray<RunningShell>): RunningSummary {
  let running = 0;
  let attention = 0;
  for (const shell of shells) {
    const state = classifyRunningThread(shell);
    if (state === "running") running += 1;
    else if (state === "attention") attention += 1;
  }
  return { running, attention };
}

export interface RunningThread {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly title: string;
  readonly state: RunningThreadState;
}

export interface RunningProjectGroup {
  readonly key: string;
  readonly title: string;
  readonly running: number;
  readonly attention: number;
  readonly threads: ReadonlyArray<RunningThread>;
}

/**
 * Busy threads grouped by project, projects by title. Threads needing the user lead; the rest
 * keep the order they started, so rows stay put while they work.
 */
export function buildRunningGroups(
  shells: ReadonlyArray<RunningShell>,
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "title">>,
): RunningProjectGroup[] {
  const projectTitle = new Map(
    projects.map((project) => [JSON.stringify([project.environmentId, project.id]), project.title]),
  );
  const groups = new Map<string, Array<{ shell: RunningShell; state: RunningThreadState }>>();
  for (const shell of shells) {
    const state = classifyRunningThread(shell);
    if (state === null) continue;
    const key = JSON.stringify([shell.environmentId, shell.projectId]);
    const group = groups.get(key) ?? [];
    group.push({ shell, state });
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, entries]): RunningProjectGroup => {
      const threads = entries
        .toSorted(
          (left, right) =>
            Number(right.state === "attention") - Number(left.state === "attention") ||
            left.shell.createdAt.localeCompare(right.shell.createdAt),
        )
        .map(({ shell, state }) => ({
          key: JSON.stringify([shell.environmentId, shell.id]),
          ref: scopeThreadRef(shell.environmentId, shell.id),
          title: shell.title,
          state,
        }));
      const attention = threads.filter((thread) => thread.state === "attention").length;
      return {
        key,
        title: projectTitle.get(key) ?? "Unknown project",
        running: threads.length - attention,
        attention,
        threads,
      };
    })
    .toSorted((left, right) => left.title.localeCompare(right.title));
}
