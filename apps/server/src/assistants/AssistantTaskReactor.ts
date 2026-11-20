import {
  CommandId,
  MessageId,
  type AssistantTask,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
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
  turnItemUpdateCanEndBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
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
import { deliveredRunOf } from "./AssistantService.ts";
import { AssistantTasks, taskStatusOf } from "./AssistantTasks.ts";
import { TaskEventNotices } from "./TaskEventNotices.ts";

const TERMINAL = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] satisfies ReadonlyArray<TaskEventStatus>);
const LIVE = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const LAST_MESSAGE_CHARS = 1_500;
/**
 * The longest a finished run waits on commands or monitors it did not mark awaited before it
 * reports: as often a test the agent reads on exit as a dev server that never ends.
 */
export const UNAWAITED_HOLD = Duration.minutes(30);
/** Approvals a policy or the agent itself settles within seconds never reach an assistant. */
export const REQUEST_WAKE_GRACE = Duration.seconds(10);

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
    task: Option.Option<{ readonly sourceThreadId?: ThreadId | null | undefined }>,
    report: Effect.Effect<boolean>,
  ) => (Option.isSome(task) && task.value.sourceThreadId != null ? report : Effect.succeed(false));

  /**
   * Why a completed run does not report yet: its thread goes on by itself (a newer run is lined up,
   * or it parked on work that wakes it when done, such as subagents and awaited commands), or it
   * left commands or monitors running that it did not mark awaited, which hold it for a while.
   */
  const holdOf = Effect.fnUntraced(function* (run: {
    readonly id: string;
    readonly threadId: ThreadId;
    readonly ordinal: number;
  }) {
    const { runs } = yield* threads.getThreadRecords(run.threadId, ["runs"]);
    if (runs.some((other) => other.ordinal > run.ordinal && LIVE.has(other.status))) {
      return "resumes" as const;
    }
    const shell = yield* engine.getThreadShell(run.threadId);
    const pending = (shell?.pendingBackgroundTasks ?? []).filter(
      (task) => !isPullRequestWatchTask(task),
    );
    if (backgroundWorkHoldsCompletion(pending)) return "resumes" as const;
    return pending.length > 0 ? ("unawaited" as const) : ("none" as const);
  });

  /**
   * Leaves the assistant's list once the task is done and its result reached the assistant: its
   * last run completed, nothing waits on the user, and the assistant's turn that read the notice
   * of that run (or of one that already said the same) completed.
   */
  const dismissIfDelivered = Effect.fn("AssistantTaskReactor.dismissIfDelivered")(
    function* (threadId: ThreadId) {
      const task = yield* tasks.forThread(threadId);
      if (Option.isNone(task) || task.value.dismissedAt !== null) return;
      const owner = yield* needsUser.conversation(task.value.assistantId);
      if (Option.isNone(owner)) return;
      const shell = yield* engine.getThreadShell(threadId);
      if (shell == null || shell.activeRunId !== null || taskStatusOf(shell) !== "done") return;
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const last = deliveredRunOf(runs);
      if (last?.status !== "completed" || (yield* holdOf(last)) === "resumes") return;
      const notice = yield* notices.told({ threadId: owner.value.threadId, run: last });
      if (Option.isNone(notice)) return;
      const { runs: ownerRuns } = yield* threads.getThreadRecords(owner.value.threadId, ["runs"]);
      const read = ownerRuns.find((run) => run.userMessageId === notice.value);
      if (read?.status !== "completed") return;
      yield* tasks.autoDismiss(threadId, last.id);
    },
    Effect.catchCause((cause) => Effect.logWarning("assistant task dismissal skipped", { cause })),
  );

  /** The task an assistant's run read the notice of, when that notice is still the latest. */
  const noticedTask = Effect.fn("AssistantTaskReactor.noticedTask")(function* (run: {
    readonly threadId: ThreadId;
    readonly userMessageId: string;
  }) {
    if (!run.userMessageId.startsWith(TASK_EVENT_MESSAGE_PREFIX)) return Option.none<ThreadId>();
    const rows = yield* sql<{ readonly subject_thread_id: string }>`
      SELECT subject_thread_id FROM assistant_task_notices
      WHERE thread_id = ${run.threadId} AND message_id = ${run.userMessageId}`;
    return Option.fromNullishOr(rows[0]?.subject_thread_id as ThreadId | undefined);
  });

  /** Tells the owner how a run of its task ended, through the notices door. */
  const report = Effect.fn("AssistantTaskReactor.report")(function* (
    task: AssistantTask,
    run: Pick<
      OrchestrationV2Run,
      "id" | "threadId" | "status" | "userMessageId" | "checkpointId" | "ordinal"
    >,
  ) {
    const owner = yield* needsUser.conversation(task.assistantId);
    if (Option.isNone(owner)) return;
    const shell = yield* engine.getThreadShell(run.threadId).pipe(Effect.orElseSucceed(() => null));
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
        title: shell?.title ?? task.title,
        threadId: run.threadId,
        status: run.status as TaskEventStatus,
        lastMessage,
      }),
      createdBy: "agent",
      senderThreadId: run.threadId,
    });
    // A notice the assistant already read can cover this run too.
    if (run.status === "completed") yield* dismissIfDelivered(run.threadId);
  });

  /** Tasks whose last completed run is held, until the work holding it ends or the hold expires. */
  const holds = yield* FiberMap.make<ThreadId>();

  /**
   * Reports a held task's last run once nothing holds it any more. `expired` stops unawaited
   * commands and monitors from holding it: a dev server never ends.
   */
  const release = Effect.fn("AssistantTaskReactor.release")(function* (
    task: AssistantTask,
    expired: boolean,
  ) {
    const { runs } = yield* threads.getThreadRecords(task.threadId, ["runs"]);
    const last = deliveredRunOf(runs);
    if (last?.status !== "completed") return false;
    const hold = yield* holdOf(last);
    if (hold === "resumes" || (hold === "unawaited" && !expired)) return false;
    yield* report(task, last);
    return true;
  });

  const holdReport = (task: AssistantTask) =>
    FiberMap.run(
      holds,
      task.threadId,
      Effect.sleep(UNAWAITED_HOLD).pipe(
        Effect.andThen(release(task, true)),
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant task held report failed", {
            threadId: task.threadId,
            cause,
          }),
        ),
      ),
    ).pipe(Effect.asVoid);

  const handle: AssistantTaskReactor["Service"]["handle"] = Effect.fn(
    "AssistantTaskReactor.handle",
  )(
    function* (event) {
      if (event.type === "thread.deleted" || event.type === "thread.archived") {
        const task = yield* tasks.forThread(event.threadId);
        yield* FiberMap.remove(holds, event.threadId);
        yield* forRequest(task, groups.settleLaunch(event.threadId));
        return;
      }
      // Background work ending, with no run after it, is the only sign a launched thread is done.
      if (
        (event.type === "provider-thread.updated" &&
          !backgroundWorkHoldsCompletion(
            (event.payload.pendingBackgroundTasks ?? []).filter(
              (task) => !isPullRequestWatchTask(task),
            ),
          )) ||
        (event.type === "turn-item.updated" && turnItemUpdateCanEndBackgroundWork(event.payload))
      ) {
        const task = yield* tasks.forThread(event.threadId);
        if (yield* forRequest(task, groups.settleLaunch(event.threadId))) return;
        if (Option.isSome(task) && (yield* FiberMap.has(holds, event.threadId))) {
          if (yield* release(task.value, false)) yield* FiberMap.remove(holds, event.threadId);
        }
        return;
      }
      if (event.type !== "run.created" && event.type !== "run.updated") return;
      const run = event.payload;
      if (!TERMINAL.has(run.status)) return;
      if (run.status === "completed") {
        const noticed = yield* noticedTask(run);
        if (Option.isSome(noticed)) yield* dismissIfDelivered(noticed.value);
      }
      const task = yield* tasks.forThread(run.threadId);
      if (Option.isNone(task)) return;
      if (yield* forRequest(task, groups.settleLaunch(run.threadId))) return;
      // A run that ends with work still pending is partial: the run that really ends reports.
      // Failures always report; a wrong read reports rather than staying silent.
      if (run.status === "completed") {
        const hold = yield* holdOf(run).pipe(Effect.orElseSucceed(() => "none" as const));
        if (hold !== "none") return yield* holdReport(task.value);
      }
      yield* FiberMap.remove(holds, run.threadId);
      yield* report(task.value, run);
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
      const toGroup = yield* forRequest(task, groups.syncWaitingThread(wait.threadId));
      // The default assistant hears of a group's waits too, so a settled one is taken back from it.
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
      if (toGroup) return;
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

  /**
   * On start, tasks whose delivery completed while the server was down leave the list, and a run
   * held before the restart reports: the session that would have resumed it is gone.
   */
  const dismissDelivered = tasks.list.pipe(
    Effect.flatMap((all) =>
      Effect.forEach(
        all.filter((task) => task.dismissedAt === null),
        (task) =>
          Effect.gen(function* () {
            yield* dismissIfDelivered(task.threadId);
            if (yield* forRequest(Option.some(task), groups.settleLaunch(task.threadId))) return;
            yield* release(task, true);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("assistant task catch-up skipped", {
                threadId: task.threadId,
                cause,
              }),
            ),
          ),
        { discard: true },
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
      // Folding beside the streams, not before them, so no run that ends meanwhile is missed;
      // once per start, outside the retry, so a resubscribe never folds again.
      yield* forkParked(foldBacklogs);
      yield* forkParked(dismissDelivered);
      yield* forkParked(
        keepRunning(
          "assistant task run stream",
          // Subscribed before the waiting tasks are checked, so work that ended while no stream
          // listened is caught up and an end seen both ways settles once.
          Stream.runForEach(
            Stream.unwrap(
              engine.subscribeDomainEvents.pipe(Effect.tap(() => groups.settleWaiting)),
            ),
            handle,
          ),
        ),
      );
      // A request waits a short grace before it wakes anyone, keyed by wait so its resolution
      // cancels the wake; the wake still checks the request is open when the grace ends.
      const graces = yield* FiberMap.make<string>();
      const onWait = (change: UserWaitChange) =>
        change.wait.source === "decision"
          ? handleWait(change)
          : change.type === "opened"
            ? FiberMap.run(
                graces,
                change.wait.key,
                Effect.sleep(REQUEST_WAKE_GRACE).pipe(Effect.andThen(handleWait(change))),
                { onlyIfMissing: true },
              ).pipe(Effect.asVoid)
            : FiberMap.remove(graces, change.wait.key).pipe(Effect.andThen(handleWait(change)));
      // `changes` opens with what already waits, so a start also catches up.
      yield* forkParked(
        keepRunning("assistant task wait stream", Stream.runForEach(needsUser.changes, onWait)),
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
