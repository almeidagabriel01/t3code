import {
  markActivityRead,
  planActivityClear,
  planActivityMarkAllRead,
  type ActivityEntry,
  type ActivityReadPlan,
} from "@t3tools/client-runtime/state/thread-activity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const NOOP = () => undefined;

/** Activity's read actions with the selectors web uses; each row is read at its own time. */
export function useActivityRead(entries: readonly ActivityEntry[], now: string) {
  const operable = useEnvironmentsWithScope(
    entries.map((entry) => entry.thread),
    AuthOrchestrationOperateScope,
  );
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const isOperable = (thread: EnvironmentThreadShell) => operable.has(thread.environmentId);
  const run = async (plan: ActivityReadPlan) => {
    let failed = false;
    // No holds on mobile: rows leave once the server records the visit.
    await markActivityRead({
      plan,
      release: NOOP,
      restore: NOOP,
      visit: async (thread, visitedAt) => {
        const result = await visitThread({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, visitedAt },
        });
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return "visited";
        failed = true;
        return "failed";
      },
    });
    if (failed) Dialog.alert("Could not mark every thread as read");
  };
  return {
    isOperable,
    markAllRead: () => run(planActivityMarkAllRead(entries, isOperable, now)),
    clearRead: () => run(planActivityClear(entries, isOperable, now)),
    clearOne: (key: string) => run(planActivityClear(entries, isOperable, now, key)),
  };
}
