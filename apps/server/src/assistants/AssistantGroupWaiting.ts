import type { RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { MACHINE_REQUEST_KINDS, requestDecision } from "../autonomy/needsYou.ts";
import { NOTICE_REQUEST_PREFIX } from "../decisions/DecisionService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

/** Something a thread waits on the user for right now. */
export interface ThreadWait {
  /** Stable per wait (`request:<id>` or `decision:<id>`): one notice per wait across restarts. */
  readonly key: string;
  readonly threadId: ThreadId;
  readonly decisionId: string | null;
  readonly title: string;
  readonly context: string;
  readonly options: ReadonlyArray<string>;
}

const optionLabels = (json: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.flatMap((option) =>
          typeof option?.label === "string" && option.label !== "" ? [option.label] : [],
        )
      : [];
  } catch {
    return [];
  }
};

/**
 * What the given threads wait on the user for: pending runtime requests T3 does not answer itself
 * (approvals, questions) and open decisions they asked with t3_decision. Decisions that only mirror
 * one of those requests, and autonomy's own notices, are left out so one wait is listed once.
 */
export const threadsWaitingOnUser = Effect.fn("AssistantGroupWaiting.threadsWaitingOnUser")(
  function* (threads: ReadonlyArray<{ readonly threadId: ThreadId; readonly agent: string }>) {
    if (threads.length === 0) return [];
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const ids = threads.map((thread) => thread.threadId);
    const agentOf = new Map(threads.map((thread) => [thread.threadId as string, thread.agent]));
    const waits: ThreadWait[] = [];
    const requests = yield* sql<{
      readonly runtime_request_id: string;
      readonly thread_id: string;
    }>`
      SELECT runtime_request_id, thread_id FROM orchestration_v2_projection_runtime_requests
      WHERE thread_id IN ${sql.in(ids)} AND status = 'pending'
        AND kind NOT IN ${sql.in(MACHINE_REQUEST_KINDS)}
      ORDER BY created_at, runtime_request_id`;
    for (const row of requests) {
      const threadId = row.thread_id as ThreadId;
      const context = yield* projections
        .getRuntimeResponseContext(threadId, row.runtime_request_id as RuntimeRequestId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (context?.request === undefined || context.request.status !== "pending") continue;
      const built = requestDecision(
        agentOf.get(row.thread_id) ?? "A member",
        context.request,
        context.item,
      );
      waits.push({
        key: `request:${row.runtime_request_id}`,
        threadId,
        decisionId: null,
        title: built.title,
        context: built.context,
        options: built.answerable ? built.options.map((option) => option.label) : [],
      });
    }
    const decisions = yield* sql<{
      readonly decision_id: string;
      readonly from_thread_id: string;
      readonly title: string;
      readonly context: string;
      readonly options_json: string;
    }>`
      SELECT decision_id, from_thread_id, title, context, options_json FROM decisions
      WHERE from_thread_id IN ${sql.in(ids)} AND status = 'open'
        AND approval_request_id IS NULL
        AND client_request_id NOT LIKE ${`${NOTICE_REQUEST_PREFIX}%`}
      ORDER BY created_at, decision_id`;
    for (const row of decisions) {
      waits.push({
        key: `decision:${row.decision_id}`,
        threadId: row.from_thread_id as ThreadId,
        decisionId: row.decision_id,
        title: row.title,
        context: row.context,
        options: optionLabels(row.options_json),
      });
    }
    return waits;
  },
);
