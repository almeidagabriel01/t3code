import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== "idle") return false;
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

/**
 * A thread its own client is launching reads as preparing until its first run lands.
 * The server commits the thread before its run, so the list would otherwise place it twice.
 */
export function asLaunchingThread<T extends EnvironmentThreadShell>(thread: T): T {
  if (thread.latestRun !== null || thread.runtime !== null) return thread;
  return {
    ...thread,
    runtime: {
      status: "preparing",
      activeRunId: null,
      providerInstanceId: thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: thread.updatedAt,
    },
  };
}
