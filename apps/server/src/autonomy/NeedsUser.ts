import {
  assistantIdFromThreadId,
  CommandId,
  DecisionId,
  DEFAULT_ASSISTANT_ID,
  isAssistantThreadId,
  isProviderNativeSubagentThread,
  RuntimeRequestId,
  ThreadId,
  type Decision,
  type DecisionsEvent,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { AssistantTasks } from "../assistants/AssistantTasks.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  MACHINE_REQUEST_KINDS,
  requestDecision,
  waitWakeId,
  type RequestDecision,
} from "./needsYou.ts";

/**
 * One thing a thread waits on the user for: a pending runtime request (approval or question) or
 * an open decision. `key` (`request:<id>` / `decision:<id>`) identifies it across restarts.
 */
export type UserWait =
  | {
      readonly source: "request";
      readonly key: string;
      readonly threadId: ThreadId;
      readonly requestId: RuntimeRequestId;
      readonly requestKind: OrchestrationV2RuntimeRequest["kind"];
      readonly createdAt: string;
    }
  | {
      readonly source: "decision";
      readonly key: string;
      readonly threadId: ThreadId;
      readonly decision: Decision;
      readonly createdAt: string;
    };

/** The assistant following a thread, and its current conversation. */
export interface WaitOwner {
  readonly assistantId: string;
  readonly name: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** The task's title, when its thread has none. */
  readonly title: string;
  /** The waiting thread is a delegate_task child, whose questions go to its parent agent first. */
  readonly delegated: boolean;
}

/** An assistant's live conversation. */
export interface AssistantConversation {
  readonly name: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

/** Subagent chains are shallow; the cap only guards a malformed lineage loop. */
const MAX_CHAIN_DEPTH = 8;

export interface UserWaitChange {
  readonly type: "opened" | "resolved";
  readonly wait: UserWait;
}

const isMachineKind = (kind: string) =>
  (MACHINE_REQUEST_KINDS as ReadonlyArray<string>).includes(kind);

/** Notices only inform, and a request's mirror is told about through the request itself. */
const decisionWaitsOnUser = (decision: Decision) =>
  decision.notice !== true && decision.approvalRequestId === undefined;

const requestWait = (input: {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly requestKind: OrchestrationV2RuntimeRequest["kind"];
  readonly createdAt: string;
}): UserWait => ({ source: "request", key: `request:${input.requestId}`, ...input });

const decisionWait = (decision: Decision): UserWait => ({
  source: "decision",
  key: `decision:${decision.id}`,
  threadId: decision.fromThreadId,
  decision,
  createdAt: decision.createdAt,
});

export function requestWaitChange(event: OrchestrationV2DomainEvent): UserWaitChange | null {
  if (event.type !== "runtime-request.updated" || isMachineKind(event.payload.kind)) return null;
  const request = event.payload;
  return {
    type: request.status === "pending" ? "opened" : "resolved",
    wait: requestWait({
      threadId: event.threadId,
      requestId: request.id,
      requestKind: request.kind,
      createdAt: DateTime.formatIso(request.createdAt),
    }),
  };
}

export function decisionWaitChange(event: DecisionsEvent): UserWaitChange | null {
  if (event.type !== "upserted" || !decisionWaitsOnUser(event.decision)) return null;
  return {
    type: event.decision.status === "open" ? "opened" : "resolved",
    wait: decisionWait(event.decision),
  };
}

/** Resubscribes a failed event stream for good: 1s, doubling, at most 30s apart. */
export const resubscribeSchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

const opened = (wait: UserWait): UserWaitChange => ({ type: "opened", wait });

/** Keeps a source alive; each (re)subscription starts with what waits at that moment. */
const resubscribing = <A, E, R>(name: string, source: Stream.Stream<A, E, R>) =>
  source.pipe(
    Stream.tapCause((cause) =>
      Effect.logWarning(`needs-user ${name} stream failed; resubscribing`, { cause }),
    ),
    Stream.retry(resubscribeSchedule),
    // The schedule never ends, so no failure gets past it.
    Stream.orDie,
  );

/** The single answer to "what is waiting on the user", shared by notices and assistant wakes. */
export class NeedsUser extends Context.Service<
  NeedsUser,
  {
    /** Everything waiting now: pending requests, then open decisions oldest first. */
    readonly pending: Effect.Effect<ReadonlyArray<UserWait>, SqlError>;
    /**
     * What waits at each (re)subscription as `opened`, then opens and resolutions. Waits repeat
     * (replays, resubscriptions): key side effects on `wait.key`.
     */
    readonly changes: Stream.Stream<UserWaitChange>;
    /** What it asks, worded with `agent` as the asker; None once it no longer waits. */
    readonly describe: (
      wait: UserWait,
      agent: string,
    ) => Effect.Effect<Option.Option<RequestDecision>, ProjectionStore.ProjectionStoreV2Error>;
    /**
     * The assistant following the thread: the launcher of it or of an ancestor (`AssistantTasks`),
     * or the assistant whose conversation started its delegate_task chain. Assistant and group
     * member conversations follow no one.
     */
    readonly owner: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<WaitOwner>, SqlError | Orchestrator.OrchestratorV2Error>;
    /** The assistant's live conversation; None once archived or before it has one. */
    readonly conversation: (
      assistantId: string,
    ) => Effect.Effect<Option.Option<AssistantConversation>, SqlError>;
    /** The default assistant's conversation: the user's point of contact for every wait. */
    readonly defaultAssistant: Effect.Effect<Option.Option<AssistantConversation>, SqlError>;
    /** Takes back a wake about the wait that `targetThreadId` has not started yet. */
    readonly withdrawWake: (
      targetThreadId: ThreadId,
      wait: Pick<UserWait, "threadId" | "key">,
    ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
  }
>()("t3/autonomy/NeedsUser") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const decisions = yield* DecisionService.DecisionService;
  const tasks = yield* AssistantTasks;

  const pendingRequests = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly runtime_request_id: string;
      readonly thread_id: string;
      readonly kind: string;
      readonly created_at: string;
    }>`
      SELECT runtime_request_id, thread_id, kind, created_at
      FROM orchestration_v2_projection_runtime_requests
      WHERE status = 'pending' AND kind NOT IN ${sql.in(MACHINE_REQUEST_KINDS)}`;
    return rows.map((row) =>
      requestWait({
        threadId: ThreadId.make(row.thread_id),
        requestId: RuntimeRequestId.make(row.runtime_request_id),
        requestKind: row.kind as OrchestrationV2RuntimeRequest["kind"],
        createdAt: row.created_at,
      }),
    );
  });

  const pending: NeedsUser["Service"]["pending"] = Effect.gen(function* () {
    const requests = yield* pendingRequests;
    const open = yield* decisions.list({}).pipe(Effect.orElseSucceed(() => []));
    return [
      ...requests,
      ...open
        .filter((decision) => decision.status === "open" && decisionWaitsOnUser(decision))
        .map(decisionWait),
    ];
  });

  // Subscribe first, then read what waits: a request opening in between arrives by the stream,
  // the read or both, and consumers key on the wait, so twice is once.
  const requestChanges = Stream.unwrap(
    Effect.gen(function* () {
      const live = yield* engine.subscribeDomainEvents;
      const now = yield* pendingRequests;
      return Stream.concat(
        Stream.fromIterable(now.map(opened)),
        live.pipe(Stream.map(requestWaitChange)),
      );
    }),
  );

  // The decision service subscribes before it takes its snapshot, under its writers' lock.
  const decisionChanges = decisions.subscribe.pipe(
    Stream.flatMap((event) =>
      event.type === "snapshot"
        ? Stream.fromIterable(
            event.decisions
              .filter((decision) => decision.status === "open" && decisionWaitsOnUser(decision))
              .map((decision) => opened(decisionWait(decision))),
          )
        : Stream.succeed(decisionWaitChange(event)),
    ),
  );

  const changes: NeedsUser["Service"]["changes"] = Stream.merge(
    resubscribing("domain event", requestChanges),
    resubscribing("decision", decisionChanges),
  ).pipe(Stream.filter(Predicate.isNotNull));

  const describe: NeedsUser["Service"]["describe"] = Effect.fn("NeedsUser.describe")(
    function* (wait, agent) {
      if (wait.source === "decision") {
        const current = yield* decisions
          .get(DecisionId.make(wait.decision.id))
          .pipe(Effect.orElseSucceed(() => null));
        if (current?.status !== "open") return Option.none();
        return Option.some({
          title: current.title,
          context: current.context,
          options: current.options,
          answerable: true,
        });
      }
      const { request, item } = yield* projections.getRuntimeResponseContext(
        wait.threadId,
        wait.requestId,
      );
      if (request === undefined || request.status !== "pending") return Option.none();
      return Option.some(requestDecision(agent, request, item));
    },
  );

  const conversation = Effect.fnUntraced(function* (assistantId: string) {
    const rows = yield* sql<{
      readonly name: string;
      readonly thread_id: string | null;
      readonly project_id: string;
    }>`
      SELECT name, thread_id, project_id FROM assistants
      WHERE assistant_id = ${assistantId} AND archived_at IS NULL`;
    const row = rows[0];
    return row === undefined || row.thread_id === null
      ? Option.none<AssistantConversation>()
      : Option.some({
          name: row.name,
          threadId: ThreadId.make(row.thread_id),
          projectId: row.project_id as ProjectId,
        });
  });

  const owner: NeedsUser["Service"]["owner"] = Effect.fn("NeedsUser.owner")(function* (threadId) {
    const follow = (assistantId: string, title: string, delegated: boolean) =>
      conversation(assistantId).pipe(
        Effect.map(Option.map((value) => ({ ...value, assistantId, title, delegated }))),
      );
    let current = threadId;
    let delegated = false;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
      if (isAssistantThreadId(current)) return Option.none();
      const task = yield* tasks.forThread(current);
      if (Option.isSome(task)) {
        return yield* follow(task.value.assistantId, task.value.title, delegated);
      }
      const { thread } = yield* engine.getThreadRecords(current, []);
      const parent = thread.lineage.parentThreadId;
      if (thread.lineage.relationshipToParent !== "subagent" || parent === null) {
        return Option.none();
      }
      const native = isProviderNativeSubagentThread(thread);
      if (depth === 0) delegated = !native;
      if (isAssistantThreadId(parent)) {
        // A native subagent is part of the assistant's own turn.
        if (native) return Option.none();
        const group = yield* sql`SELECT 1 FROM assistant_group_threads WHERE thread_id = ${parent}`;
        const assistantId = assistantIdFromThreadId(parent);
        if (group.length > 0 || assistantId === null) return Option.none();
        return yield* follow(assistantId, thread.title, delegated);
      }
      current = parent;
    }
    return Option.none();
  });

  const withdrawWake: NeedsUser["Service"]["withdrawWake"] = Effect.fn("NeedsUser.withdrawWake")(
    function* (targetThreadId, wait) {
      // Wakes queued before the id named the conversation woken were keyed by the waiting thread.
      const ids = new Set([
        waitWakeId(targetThreadId, wait.key),
        waitWakeId(wait.threadId, wait.key),
      ]);
      const { runs } = yield* engine.getThreadRecords(targetThreadId, ["runs"]);
      for (const run of runs) {
        if (run.status !== "queued" || !ids.has(run.userMessageId)) continue;
        yield* engine.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`${run.userMessageId}:cancel`),
          threadId: targetThreadId,
          runId: run.id,
        });
      }
    },
  );

  return NeedsUser.of({
    pending,
    changes,
    describe,
    owner,
    conversation,
    defaultAssistant: conversation(DEFAULT_ASSISTANT_ID),
    withdrawWake,
  });
});

export const layer = Layer.effect(NeedsUser, make);
