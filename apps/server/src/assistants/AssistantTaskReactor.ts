import { type OrchestrationV2DomainEvent, type ProjectId, type ThreadId } from "@t3tools/contracts";
import {
  QUIET_REPLY,
  TASK_EVENT_MESSAGE_PREFIX,
  taskEventHeadline,
  type TaskEventStatus,
} from "@t3tools/shared/assistantTaskEvents";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { AssistantTasks } from "./AssistantTasks.ts";
import { TaskEventNotices } from "./TaskEventNotices.ts";

const TERMINAL = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] satisfies ReadonlyArray<TaskEventStatus>);
const LAST_MESSAGE_CHARS = 1_500;

export function taskWakeText(input: {
  readonly title: string;
  readonly threadId: ThreadId;
  readonly status: TaskEventStatus;
  readonly lastMessage: string | null;
}): string {
  const last =
    input.lastMessage === null
      ? ""
      : `\n\nIts last message:\n${input.lastMessage.slice(0, LAST_MESSAGE_CHARS)}`;
  return `${taskEventHeadline(input)}${last}\n\nIf this tells the user nothing new, reply with exactly ${QUIET_REPLY} and stop. Otherwise check its diff and run the tests, send any fixes to the task with t3_thread_send (never edit files here), then tell the user what changed in at most 3 short plain lines with the task's link. Add a "Waiting on you" line only if the user must act now; if you are only waiting on the task, leave it out.`;
}

/**
 * Wakes the assistant when a thread it launched ends a run, so it follows its tasks without
 * waiting on them. `TaskEventNotices` decides whether the run is news and keeps one per run.
 */
export class AssistantTaskReactor extends Context.Service<
  AssistantTaskReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/assistants/AssistantTaskReactor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const tasks = yield* AssistantTasks;
  const notices = yield* TaskEventNotices;

  const handle: AssistantTaskReactor["Service"]["handle"] = Effect.fn(
    "AssistantTaskReactor.handle",
  )(
    function* (event) {
      if (event.type !== "run.created" && event.type !== "run.updated") return;
      const run = event.payload;
      if (!TERMINAL.has(run.status)) return;
      const task = yield* tasks.forThread(run.threadId);
      if (Option.isNone(task)) return;
      const owner = yield* sql<{
        readonly thread_id: string | null;
        readonly project_id: string;
      }>`
        SELECT thread_id, project_id FROM assistants
        WHERE assistant_id = ${task.value.assistantId} AND archived_at IS NULL`;
      const assistantThread = owner[0]?.thread_id;
      if (owner[0] === undefined || assistantThread === null || assistantThread === undefined) {
        return;
      }
      const shell = yield* engine
        .getThreadShell(run.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const lastMessage = yield* threads
        .getThreadRecords(run.threadId, ["messages"], {
          messageRoles: ["assistant"],
          messageRunIds: [run.id],
        })
        .pipe(
          Effect.map(
            (records) =>
              records.messages.findLast((message) => message.text.trim() !== "")?.text ?? null,
          ),
          Effect.orElseSucceed(() => null),
        );
      yield* notices.send({
        threadId: assistantThread as ThreadId,
        // The thread being written to is the assistant's, so its project, not the task's.
        projectId: owner[0].project_id as ProjectId,
        run,
        messageId: `${TASK_EVENT_MESSAGE_PREFIX}${run.id}`,
        text: taskWakeText({
          title: shell?.title ?? task.value.title,
          threadId: run.threadId,
          status: run.status as TaskEventStatus,
          lastMessage,
        }),
        createdBy: "agent",
        senderThreadId: run.threadId,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant task reactor failed", { eventType: event.type, cause }),
        ),
      ),
  );

  /** Task events queued before the notices door existed may sit in a backlog; keep the newest. */
  const foldBacklogs = Effect.gen(function* () {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM assistants WHERE archived_at IS NULL AND thread_id IS NOT NULL`;
    yield* Effect.forEach(rows, (row) => notices.foldQueued(row.thread_id as ThreadId), {
      discard: true,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("assistant task backlog fold failed", { cause }),
    ),
  );

  const start: AssistantTaskReactor["Service"]["start"] = () =>
    forkParked(
      // Folding beside the stream, not before it, so no run that ends meanwhile is missed.
      Effect.all([foldBacklogs, Stream.runForEach(engine.streamDomainEvents, handle)], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant task event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies AssistantTaskReactor["Service"];
});

export const layer = Layer.effect(AssistantTaskReactor, make);
