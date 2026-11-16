import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import {
  QUIET_REPLY,
  TASK_EVENT_MESSAGE_PREFIX,
  taskEventHeadline,
  type TaskEventStatus,
} from "@t3tools/shared/assistantTaskEvents";
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
import { AssistantGroups } from "./AssistantGroups.ts";
import { AssistantTasks } from "./AssistantTasks.ts";
import { TaskEventNotices } from "./TaskEventNotices.ts";

const TERMINAL = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] satisfies ReadonlyArray<TaskEventStatus>);
const LIVE = new Set(["queued", "preparing", "starting", "running", "waiting"]);
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

export function waitWakeText(input: {
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
  return `Task ${link} is waiting on the user. It shows them:\n\n${card.join("\n\n")}\n\nTell the user now, in this chat, what it needs and that they answer it ${where}. Never approve, deny or answer it for them: use t3_pending_request respond only when the user tells you to in this chat. If it was already answered, reply with exactly ${QUIET_REPLY} and nothing else.`;
}

/**
 * Wakes the assistant when a thread it launched ends a run or starts waiting on the user, so it
 * follows its tasks without waiting on them. `TaskEventNotices` decides whether a run is news and
 * keeps one per run; a wait's message id derives from the wait, so a replayed event wakes once.
 * A thread launched for a group request reports to that request instead (`AssistantGroups`).
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
  const notices = yield* TaskEventNotices;
  const groups = yield* AssistantGroups;

  /** The group request a task thread was launched for takes its events; false when there is none. */
  const forRequest = (
    task: Option.Option<{ readonly launchedFromThreadId?: ThreadId | null | undefined }>,
    report: Effect.Effect<boolean>,
  ) =>
    Option.isSome(task) && task.value.launchedFromThreadId != null ? report : Effect.succeed(false);

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
      if (event.type === "thread.deleted" || event.type === "thread.archived") {
        const task = yield* tasks.forThread(event.threadId);
        yield* forRequest(task, groups.settleLaunch(event.threadId));
        return;
      }
      if (event.type !== "run.created" && event.type !== "run.updated") return;
      const run = event.payload;
      if (!TERMINAL.has(run.status)) return;
      const task = yield* tasks.forThread(run.threadId);
      if (Option.isNone(task)) return;
      if (yield* forRequest(task, groups.settleLaunch(run.threadId))) return;
      // Failures always report; a wrong read reports rather than staying silent.
      if (
        run.status === "completed" &&
        (yield* resumesOnItsOwn(run).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return;
      }
      const owner = yield* needsUser.conversation(task.value.assistantId);
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
      yield* notices.send({
        // The thread being written to is the assistant's, so its project, not the task's.
        threadId: owner.value.threadId,
        projectId: owner.value.projectId,
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

  const handleWait: AssistantTaskReactor["Service"]["handleWait"] = Effect.fn(
    "AssistantTaskReactor.handleWait",
  )(
    function* ({ type, wait }) {
      const task = yield* tasks.forThread(wait.threadId);
      if (yield* forRequest(task, groups.syncWaitingThread(wait.threadId))) return;
      if (type === "resolved") {
        // Answered before the assistants got to it: take back the wakes still queued.
        // Each conversation on its own: one failing read or cancel never keeps the other's wake.
        const targets = [
          yield* needsUser.owner(wait.threadId).pipe(Effect.orElseSucceed(() => Option.none())),
          yield* needsUser.defaultAssistant.pipe(Effect.orElseSucceed(() => Option.none())),
        ].flatMap((target) => (Option.isSome(target) ? [target.value.threadId] : []));
        for (const threadId of new Set(targets)) {
          yield* needsUser.withdrawWake(threadId, wait).pipe(
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

  /** Each loop restarts on its own failure, so one broken stream never stops the other. */
  const keepRunning = <E>(name: string, loop: Effect.Effect<void, E>) =>
    loop.pipe(
      Effect.tapCause((cause) => Effect.logWarning(`${name} failed; restarting`, { cause })),
      Effect.retry(resubscribeSchedule),
      Effect.catchCause((cause) => Effect.logWarning(`${name} stopped`, { cause })),
    );

  const start: AssistantTaskReactor["Service"]["start"] = Effect.fn("AssistantTaskReactor.start")(
    function* () {
      // Folding beside the streams, not before them, so no run that ends meanwhile is missed;
      // once per start, outside the retry, so a resubscribe never folds again.
      yield* forkParked(foldBacklogs);
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
      // A dismissed thread stops holding the group request it was launched for.
      yield* forkParked(
        keepRunning(
          "assistant task dismissal stream",
          Stream.runForEach(Stream.fromPubSub(tasks.changes), (task) =>
            task.dismissedAt == null
              ? Effect.void
              : forRequest(Option.some(task), groups.settleLaunch(task.threadId)),
          ),
        ),
      );
    },
  );

  return { start, handle, handleWait } satisfies AssistantTaskReactor["Service"];
});

export const layer = Layer.effect(AssistantTaskReactor, make);
