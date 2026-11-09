import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
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

const TASK_WAKE_PREFIX = "assistant-task:";
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const LAST_MESSAGE_CHARS = 1_500;

export function taskWakeText(input: {
  readonly title: string;
  readonly threadId: ThreadId;
  readonly status: string;
  readonly lastMessage: string | null;
}): string {
  const link = formatThreadLink({ environmentId: null, threadId: input.threadId }, input.title);
  const outcome = input.status === "completed" ? "finished" : input.status;
  const last =
    input.lastMessage === null
      ? ""
      : `\n\nIts last message:\n${input.lastMessage.slice(0, LAST_MESSAGE_CHARS)}`;
  return `Task ${link} ${outcome}.${last}\n\nCheck its diff and run the tests. Ask a group member to review when that helps, send fixes with t3_thread_send, and only then report to the user.`;
}

/**
 * Wakes the assistant when a thread it launched ends a run, so it follows its tasks without
 * waiting on them. The message id derives from the run, so a replayed event wakes once.
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
      const id = `${TASK_WAKE_PREFIX}${run.id}`;
      const sent = yield* threads
        .sendToThread({
          // The thread being written to is the assistant's, so its project, not the task's.
          projectId: owner[0].project_id as ProjectId,
          commandId: CommandId.make(id),
          messageId: MessageId.make(id),
          threadId: assistantThread as ThreadId,
          senderThreadId: run.threadId,
          text: taskWakeText({
            title: shell?.title ?? task.value.title,
            threadId: run.threadId,
            status: run.status,
            lastMessage,
          }),
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.result);
      if (sent._tag === "Failure") {
        yield* Effect.logWarning("assistant task wake could not be sent", {
          threadId: run.threadId,
          cause: sent.failure,
        });
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant task reactor failed", { eventType: event.type, cause }),
        ),
      ),
  );

  const start: AssistantTaskReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant task event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies AssistantTaskReactor["Service"];
});

export const layer = Layer.effect(AssistantTaskReactor, make);
