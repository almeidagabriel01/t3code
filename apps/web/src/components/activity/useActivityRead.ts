import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import { readEnvironmentSupportsVisitedTracking } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useUiStateStore } from "../../uiStateStore";
import { selectSidebarMarkReadTargets } from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { markActivityRead, selectActivityClear, type ActivityReadPlan } from "./activityRead";

const threadKey = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const canOperate = (thread: EnvironmentThreadShell) =>
  readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);

/** The page's bulk read actions: Mark all as read, and Clear read threads. */
export function useActivityRead(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly snoozeNow: string;
  readonly releaseThreads: (keys: readonly string[]) => void;
  readonly restoreThread: (key: string) => void;
}) {
  const { threads } = input;
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const operableEnvironments = useEnvironmentsWithScope(threads, AuthOrchestrationOperateScope);
  const visitThread = useOrchestrationCommand(threadEnvironment.visit, { reportFailure: false });
  const rawWokeAtByKey = new Map(
    threads.map((thread) => [threadKey(thread), threadWokeAt(thread, { now: input.snoozeNow })]),
  );
  const markReadTargets = (operable: (thread: EnvironmentThreadShell) => boolean) =>
    selectSidebarMarkReadTargets({
      threads,
      localLastVisitedAtByKey,
      wokeAtByKey: rawWokeAtByKey,
      canOperate: operable,
    });
  const clearPlan = (operable: (thread: EnvironmentThreadShell) => boolean) =>
    selectActivityClear({
      threads,
      localLastVisitedAtByKey,
      wokeAtByKey: rawWokeAtByKey,
      canOperate: operable,
    });
  const isOperable = (thread: EnvironmentThreadShell) =>
    operableEnvironments.has(thread.environmentId);

  const run = (plan: ActivityReadPlan<EnvironmentThreadShell>) => {
    // oxlint-disable-next-line react/purity -- runs from event handlers only
    const visitedAt = new Date().toISOString();
    void markActivityRead({
      plan,
      release: input.releaseThreads,
      restore: input.restoreThread,
      visit: async (thread) => {
        if (!canOperate(thread)) return "skipped";
        if (!readEnvironmentSupportsVisitedTracking(thread.environmentId)) {
          markThreadVisited(threadKey(thread), visitedAt);
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
  };

  return {
    canMarkAllRead: markReadTargets(isOperable).length > 0,
    markAllRead: () => {
      const targets = markReadTargets(canOperate);
      run({ markRead: targets, releaseKeys: targets.map(threadKey) });
    },
    canClearRead: clearPlan(isOperable).releaseKeys.length > 0,
    clearRead: () => run(clearPlan(canOperate)),
  };
}
