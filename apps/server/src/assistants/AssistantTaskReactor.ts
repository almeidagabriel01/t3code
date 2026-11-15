import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  isPullRequestWatchTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  NeedsUser,
  resubscribeSchedule,
  type UserWait,
  type UserWaitChange,
} from "../autonomy/NeedsUser.ts";
import { waitWakeId, type RequestDecision } from "../autonomy/needsYou.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { AssistantTasks } from "./AssistantTasks.ts";

const TASK_WAKE_PREFIX = "assistant-task:";
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const LIVE = new Set(["queued", "preparing", "starting", "running", "waiting"]);
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

function waitWakeText(input: {
  readonly title: string;
  readonly threadId: ThreadId;
  readonly source: UserWait["source"];
  readonly prompt: RequestDecision;
}): string {
  const link = formatThreadLink({ environmentId: null, threadId: input.threadId }, input.title);
  const { prompt } = input;
  const card = [
    prompt.title,
    prompt.context.trim().slice(0, LAST_MESSAGE_CHARS),
    prompt.answerable ? `Options: ${prompt.options.map((option) => option.label).join(" / ")}` : "",
  ].filter((line) => line !== "");
  const where = input.source === "decision" ? "in Activity" : `in ${link}`;
  return `Task ${link} is waiting on the user. It shows them:\n\n${card.join("\n\n")}\n\nTell the user now, in this chat, what it needs and that they answer it ${where}. Never approve, deny or answer it for them: use t3_pending_request respond only when the user tells you to in this chat. If it was already answered, say nothing about it.`;
}

/**
 * Wakes the assistant when a thread it launched ends a run or starts waiting on the user, so it
 * follows its tasks without waiting on them. Message ids derive from the run or the wait, so a
 * replayed event wakes once.
 */
export class AssistantTaskReactor extends Context.Service<
  AssistantTaskReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly handleWait: (change: UserWaitChange) => Effect.Effect<void>;
  }
>()("t3/assistants/AssistantTaskReactor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const tasks = yield* AssistantTasks;
  const needsUser = yield* NeedsUser;

  const liveOwner = Effect.fnUntraced(function* (assistantId: string) {
    const rows = yield* sql<{ readonly thread_id: string | null; readonly project_id: string }>`
      SELECT thread_id, project_id FROM assistants
      WHERE assistant_id = ${assistantId} AND archived_at IS NULL`;
    const row = rows[0];
    return row === undefined || row.thread_id === null
      ? Option.none()
      : Option.some({
          threadId: row.thread_id as ThreadId,
          projectId: row.project_id as ProjectId,
        });
  });

  /**
   * A completed run whose thread goes on by itself: a newer run is lined up, or it parked on work
   * that wakes it when done (subagents, awaited commands). That later run reports instead.
   */
  const resumesOnItsOwn = Effect.fnUntraced(function* (run: {
    readonly id: string;
    readonly threadId: ThreadId;
    readonly ordinal: number;
  }) {
    const { runs } = yield* threads.getThreadRecords(run.threadId, ["runs"]);
    if (runs.some((other) => other.ordinal > run.ordinal && LIVE.has(other.status))) return true;
    const shell = yield* engine.getThreadShell(run.threadId);
    return backgroundWorkHoldsCompletion(
      (shell?.pendingBackgroundTasks ?? []).filter((task) => !isPullRequestWatchTask(task)),
    );
  });

  const handle: AssistantTaskReactor["Service"]["handle"] = Effect.fn(
    "AssistantTaskReactor.handle",
  )(
    function* (event) {
      if (event.type !== "run.created" && event.type !== "run.updated") return;
      const run = event.payload;
      if (!TERMINAL.has(run.status)) return;
      const task = yield* tasks.forThread(run.threadId);
      if (Option.isNone(task)) return;
      // Failures always report; a wrong read reports rather than staying silent.
      if (
        run.status === "completed" &&
        (yield* resumesOnItsOwn(run).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return;
      }
      const owner = yield* liveOwner(task.value.assistantId);
      if (Option.isNone(owner)) return;
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
          projectId: owner.value.projectId,
          commandId: CommandId.make(id),
          messageId: MessageId.make(id),
          threadId: owner.value.threadId,
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

  const handleWait: AssistantTaskReactor["Service"]["handleWait"] = Effect.fn(
    "AssistantTaskReactor.handleWait",
  )(
    function* ({ type, wait }) {
      if (type === "resolved") {
        // Answered before the assistants got to it: take back the wakes still queued.
        // Each conversation on its own: one failing read or cancel never keeps the other's wake.
        const targets = [
          yield* needsUser.owner(wait.threadId).pipe(Effect.orElseSucceed(() => Option.none())),
          yield* needsUser.defaultAssistant.pipe(Effect.orElseSucceed(() => Option.none())),
        ].flatMap((target) => (Option.isSome(target) ? [target.value.threadId] : []));
        for (const threadId of new Set(targets)) {
          yield* needsUser.withdrawWake(threadId, wait.key).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("assistant wait wake could not be taken back", {
                threadId,
                key: wait.key,
                cause,
              }),
            ),
          );
        }
        return;
      }
      const owner = yield* needsUser.owner(wait.threadId);
      if (Option.isNone(owner)) return;
      // DelegatedTaskQuestionReactor already brings a delegated task's question to its parent.
      if (owner.value.delegated && wait.source === "request" && wait.requestKind === "user_input") {
        return;
      }
      const id = waitWakeId(owner.value.threadId, wait.key);
      const shell = yield* engine
        .getThreadShell(wait.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell?.archivedAt != null) return;
      const title = shell?.title ?? owner.value.title;
      const prompt = yield* needsUser.describe(wait, title);
      if (Option.isNone(prompt)) return;
      yield* threads.sendToThread({
        projectId: owner.value.projectId,
        commandId: CommandId.make(id),
        messageId: MessageId.make(id),
        threadId: owner.value.threadId,
        senderThreadId: wait.threadId,
        text: waitWakeText({
          title,
          threadId: wait.threadId,
          source: wait.source,
          prompt: prompt.value,
        }),
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, change) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant task wait wake failed", {
            threadId: change.wait.threadId,
            key: change.wait.key,
            cause,
          }),
        ),
      ),
  );

  /** Each loop restarts on its own failure, so one broken stream never stops the other. */
  const keepRunning = <E>(name: string, loop: Effect.Effect<void, E>) =>
    loop.pipe(
      Effect.tapCause((cause) => Effect.logWarning(`${name} failed; restarting`, { cause })),
      Effect.retry(resubscribeSchedule),
      Effect.catchCause((cause) => Effect.logWarning(`${name} stopped`, { cause })),
    );

  const start: AssistantTaskReactor["Service"]["start"] = Effect.fn("AssistantTaskReactor.start")(
    function* () {
      yield* forkParked(
        keepRunning(
          "assistant task run stream",
          Stream.runForEach(engine.streamDomainEvents, handle),
        ),
      );
      // `changes` opens with what already waits, so a start also catches up.
      yield* forkParked(
        keepRunning("assistant task wait stream", Stream.runForEach(needsUser.changes, handleWait)),
      );
    },
  );

  return { start, handle, handleWait } satisfies AssistantTaskReactor["Service"];
});

export const layer = Layer.effect(AssistantTaskReactor, make);
