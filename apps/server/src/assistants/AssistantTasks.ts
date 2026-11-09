import type { AssistantId, AssistantTask, ProjectId, ThreadId } from "@t3tools/contracts";
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
}

const toTask = (row: TaskRow): AssistantTask => ({
  threadId: row.thread_id as ThreadId,
  assistantId: row.assistant_id as AssistantId,
  projectId: row.project_id as ProjectId,
  title: row.title,
  createdAt: row.created_at,
});

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
    readonly list: Effect.Effect<ReadonlyArray<AssistantTask>>;
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
        INSERT OR IGNORE INTO assistant_tasks (thread_id, assistant_id, project_id, title, created_at)
        VALUES (${task.threadId}, ${task.assistantId}, ${task.projectId}, ${task.title}, ${task.createdAt})`;
      const stored = yield* forThread(task.threadId);
      if (Option.isSome(stored)) yield* PubSub.publish(changes, stored.value);
    }, Effect.orDie),
    unlink: (threadId) =>
      sql`DELETE FROM assistant_tasks WHERE thread_id = ${threadId}`.pipe(Effect.orDie),
    forThread,
    list: sql<TaskRow>`SELECT * FROM assistant_tasks ORDER BY created_at ASC, thread_id ASC`.pipe(
      Effect.map((rows) => rows.map(toTask)),
      Effect.orDie,
    ),
    removeFor: (assistantId) =>
      sql`DELETE FROM assistant_tasks WHERE assistant_id = ${assistantId}`.pipe(Effect.orDie),
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
  });
  return true;
});

/** Takes back the link of a launch that failed. */
export const unlinkTaskLaunch = (threadId: ThreadId) =>
  Effect.serviceOption(AssistantTasks).pipe(
    Effect.flatMap((tasks) => (Option.isSome(tasks) ? tasks.value.unlink(threadId) : Effect.void)),
  );
