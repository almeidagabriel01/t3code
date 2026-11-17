import type {
  AssistantId,
  AssistantTask,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { assistantTaskStatusOf } from "@t3tools/shared/assistantTaskStatus";
import {
  backgroundWorkHoldsCompletion,
  isPullRequestWatchTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { guestWaitsOnUser } from "@t3tools/shared/needsUser";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";

import { AssistantDirectory } from "./AssistantDirectory.ts";

interface TaskRow {
  readonly thread_id: string;
  readonly assistant_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly created_at: string;
  readonly dismissed_at?: string | null;
  readonly auto_dismissed_run_id?: string | null;
  readonly source_thread_id?: string | null;
}

const toTask = (row: TaskRow): AssistantTask => ({
  threadId: row.thread_id as ThreadId,
  assistantId: row.assistant_id as AssistantId,
  projectId: row.project_id as ProjectId,
  title: row.title,
  createdAt: row.created_at,
  dismissedAt: row.dismissed_at ?? null,
  sourceThreadId: (row.source_thread_id ?? null) as ThreadId | null,
});

/** A task thread's state, read from its shell: parked on background work counts as running. */
export const taskStatusOf = (shell: OrchestrationV2ThreadShell) => {
  const parked =
    backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []) && shell.status !== "failed";
  const status = parked ? "idle" : (shell.activityRunStatus ?? shell.status);
  return assistantTaskStatusOf({
    needsUser: shell.pendingRuntimeRequest !== null || guestWaitsOnUser(shell),
    runtimeStatus: status === "idle" && !parked ? null : status,
  });
};

/** Work that still ends in a run: a pull request watch ends silently on merge, so it holds nothing. */
export const threadStillWorking = (shell: OrchestrationV2ThreadShell | null) => {
  if (shell === null) return false;
  const status = taskStatusOf({
    ...shell,
    pendingBackgroundTasks: (shell.pendingBackgroundTasks ?? []).filter(
      (task) => !isPullRequestWatchTask(task),
    ),
  });
  return status === "running" || status === "waiting";
};

/**
 * The link between an assistant and a thread it launched for real work. A task thread is an
 * ordinary project thread: the row only says whose it is, and its state is the thread's own.
 */
export class AssistantTasks extends Context.Service<
  AssistantTasks,
  {
    /** A repeat for the same thread keeps the first link. */
    readonly link: (input: AssistantTask) => Effect.Effect<void>;
    /** Undoes a link whose launch then failed. */
    readonly unlink: (threadId: ThreadId) => Effect.Effect<void>;
    readonly forThread: (threadId: ThreadId) => Effect.Effect<Option.Option<AssistantTask>>;
    /** The tasks a conversation launched and nobody dismissed. */
    readonly launchedFrom: (
      sourceThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<AssistantTask>>;
    /**
     * Dismissing keeps the first time; restoring clears it and records `handledRunId`, so that
     * run's delivery never dismisses the task again. None when the thread is no task.
     */
    readonly setDismissed: (
      threadId: ThreadId,
      dismissedAt: string | null,
      handledRunId?: string | null,
    ) => Effect.Effect<Option.Option<AssistantTask>>;
    /**
     * Dismisses a task once its run's result reached its assistant. Once per run, so a Restore
     * holds until another run delivers. True when it dismissed.
     */
    readonly autoDismiss: (threadId: ThreadId, runId: string) => Effect.Effect<boolean>;
    readonly list: Effect.Effect<ReadonlyArray<AssistantTask>>;
    /** One assistant's tasks, newest first. */
    readonly listFor: (
      assistantId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<AssistantTask>>;
    readonly removeFor: (assistantId: string) => Effect.Effect<void>;
    /** Link events from now on, for the assistants stream. */
    readonly changes: PubSub.PubSub<AssistantTask>;
  }
>()("t3/assistants/AssistantTasks") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<AssistantTask>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const forThread: AssistantTasks["Service"]["forThread"] = Effect.fn("AssistantTasks.forThread")(
    function* (threadId) {
      const rows = yield* sql<TaskRow>`SELECT * FROM assistant_tasks WHERE thread_id = ${threadId}`;
      return Option.fromNullishOr(rows[0]).pipe(Option.map(toTask));
    },
    Effect.orDie,
  );

  return AssistantTasks.of({
    link: Effect.fn("AssistantTasks.link")(function* (task) {
      yield* sql`
        INSERT OR IGNORE INTO assistant_tasks
          (thread_id, assistant_id, project_id, title, created_at, source_thread_id)
        VALUES (${task.threadId}, ${task.assistantId}, ${task.projectId}, ${task.title},
          ${task.createdAt}, ${task.sourceThreadId ?? null})`;
      const stored = yield* forThread(task.threadId);
      if (Option.isSome(stored)) yield* PubSub.publish(changes, stored.value);
    }, Effect.orDie),
    unlink: Effect.fn("AssistantTasks.unlink")(function* (threadId) {
      yield* sql`DELETE FROM assistant_tasks WHERE thread_id = ${threadId}`;
    }, Effect.orDie),
    forThread,
    launchedFrom: Effect.fn("AssistantTasks.launchedFrom")(function* (sourceThreadId) {
      const rows = yield* sql<TaskRow>`
        SELECT * FROM assistant_tasks
        WHERE source_thread_id = ${sourceThreadId} AND dismissed_at IS NULL`;
      return rows.map(toTask);
    }, Effect.orDie),
    setDismissed: Effect.fn("AssistantTasks.setDismissed")(function* (
      threadId,
      dismissedAt,
      handledRunId = null,
    ) {
      yield* dismissedAt === null
        ? sql`
            UPDATE assistant_tasks
            SET dismissed_at = NULL,
              auto_dismissed_run_id = COALESCE(${handledRunId}, auto_dismissed_run_id)
            WHERE thread_id = ${threadId}`
        : sql`
            UPDATE assistant_tasks SET dismissed_at = COALESCE(dismissed_at, ${dismissedAt})
            WHERE thread_id = ${threadId}`;
      const stored = yield* forThread(threadId);
      if (Option.isSome(stored)) yield* PubSub.publish(changes, stored.value);
      return stored;
    }, Effect.orDie),
    autoDismiss: Effect.fn("AssistantTasks.autoDismiss")(function* (threadId, runId) {
      const rows = yield* sql<TaskRow>`
        UPDATE assistant_tasks SET dismissed_at = ${yield* nowIso}, auto_dismissed_run_id = ${runId}
        WHERE thread_id = ${threadId} AND dismissed_at IS NULL
          AND (auto_dismissed_run_id IS NULL OR auto_dismissed_run_id != ${runId})
        RETURNING *`;
      const dismissed = rows[0];
      if (dismissed === undefined) return false;
      yield* PubSub.publish(changes, toTask(dismissed));
      return true;
    }, Effect.orDie),
    list: sql<TaskRow>`SELECT * FROM assistant_tasks ORDER BY created_at ASC, thread_id ASC`.pipe(
      Effect.map((rows) => rows.map(toTask)),
      Effect.orDie,
    ),
    listFor: Effect.fn("AssistantTasks.listFor")(function* (assistantId, limit) {
      const rows = yield* sql<TaskRow>`
        SELECT * FROM assistant_tasks WHERE assistant_id = ${assistantId}
        ORDER BY created_at DESC, thread_id DESC LIMIT ${limit}`;
      return rows.map(toTask);
    }, Effect.orDie),
    removeFor: Effect.fn("AssistantTasks.removeFor")(function* (assistantId) {
      yield* sql`DELETE FROM assistant_tasks WHERE assistant_id = ${assistantId}`;
    }, Effect.orDie),
    changes,
  });
});

export const layer = Layer.effect(AssistantTasks, make);

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => DateTime.formatIso(DateTime.makeUnsafe(ms))),
);

/**
 * A thread launched from an assistant's conversation becomes its task. The link is written before
 * the launch so a run that ends fast still finds it; false means the caller is no assistant.
 */
export const linkTaskLaunch = Effect.fn("AssistantTasks.linkLaunch")(function* (input: {
  readonly callerThreadId: ThreadId | undefined;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
}) {
  const directory = yield* Effect.serviceOption(AssistantDirectory);
  const tasks = yield* Effect.serviceOption(AssistantTasks);
  if (input.callerThreadId === undefined || Option.isNone(directory) || Option.isNone(tasks)) {
    return false;
  }
  const owner = yield* directory.value.forThread(input.callerThreadId);
  if (Option.isNone(owner)) return false;
  yield* tasks.value.link({
    threadId: input.threadId,
    assistantId: owner.value.assistant.id,
    projectId: input.projectId,
    title: input.title,
    createdAt: yield* nowIso,
    sourceThreadId: input.callerThreadId,
  });
  return true;
});

/** Takes back the link of a launch that failed. */
export const unlinkTaskLaunch = (threadId: ThreadId) =>
  Effect.serviceOption(AssistantTasks).pipe(
    Effect.flatMap((tasks) => (Option.isSome(tasks) ? tasks.value.unlink(threadId) : Effect.void)),
  );
