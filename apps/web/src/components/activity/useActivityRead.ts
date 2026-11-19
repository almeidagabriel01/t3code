import {
  markActivityRead,
  planActivityClear,
  planActivityMarkAllRead,
  type ActivityEntry,
  type ActivityReadPlan,
} from "@t3tools/client-runtime/state/thread-activity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import { readEnvironmentServerConfigLoaded } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useUiStateStore } from "../../uiStateStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

const canOperate = (thread: EnvironmentThreadShell) =>
  readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);

/** The page's read actions: Mark all as read, Clear read, and clearing one row. */
export function useActivityRead(input: {
  readonly entries: readonly ActivityEntry[];
  readonly now: string;
  readonly releaseThreads: (keys: readonly string[]) => void;
  readonly restoreThread: (key: string) => void;
}) {
  const { entries, now } = input;
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const operableEnvironments = useEnvironmentsWithScope(
    entries.map((entry) => entry.thread),
    AuthOrchestrationOperateScope,
  );
  const visitThread = useOrchestrationCommand(threadEnvironment.visit, { reportFailure: false });
  const isOperable = (thread: EnvironmentThreadShell) =>
    operableEnvironments.has(thread.environmentId);

  const run = (plan: ActivityReadPlan) =>
    void markActivityRead({
      plan,
      release: input.releaseThreads,
      restore: input.restoreThread,
      visit: async (thread, visitedAt) => {
        if (!canOperate(thread)) return "skipped";
        if (!readEnvironmentServerConfigLoaded(thread.environmentId)) {
          markThreadVisited(
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            visitedAt,
          );
          return "visited";
        }
        const result = await visitThread({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, visitedAt },
        });
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return "visited";
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to mark thread as read",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return "failed";
      },
    });

  const clearPlan = planActivityClear(entries, isOperable, now);
  return {
    isOperable,
    canMarkAllRead: planActivityMarkAllRead(entries, isOperable, now).visits.length > 0,
    markAllRead: () => run(planActivityMarkAllRead(entries, canOperate, now)),
    canClearRead: clearPlan.releaseKeys.length > 0,
    clearRead: () => run(planActivityClear(entries, canOperate, now)),
    clearOne: (key: string) => run(planActivityClear(entries, canOperate, now, key)),
  };
}
