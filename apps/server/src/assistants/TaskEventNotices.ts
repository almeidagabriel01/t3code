import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { TASK_EVENT_MESSAGE_PREFIX } from "@t3tools/shared/assistantTaskEvents";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** What the last notice told one conversation about one thread. */
interface NoticeMark {
  readonly runId: string;
  readonly status: string;
  readonly headSha: string | null;
}

interface RunFacts extends NoticeMark {
  /** The run answers a message an agent sent the thread, so its reply is news of its own. */
  readonly asked: boolean;
  readonly changedFiles: number;
}

/**
 * A run is news when it, or a run since the last notice, was asked for or changed files, or when
 * it moved HEAD or ended in another state. A stopped run is judged before its checkpoint; only news
 * is marked, so the capture's re-send is judged again.
 */
function isNews(previous: NoticeMark | undefined, run: RunFacts): boolean {
  if (previous === undefined) return true;
  if (previous.runId === run.runId) return false;
  return (
    run.asked ||
    run.changedFiles > 0 ||
    run.status !== previous.status ||
    (run.headSha !== null && run.headSha !== previous.headSha)
  );
}

export type NoticeOutcome = "sent" | "unchanged" | "failed";

export interface TaskEventNotice {
  /** The conversation to wake. */
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** The ended run of the thread the event is about. */
  readonly run: Pick<
    OrchestrationV2Run,
    "id" | "threadId" | "status" | "userMessageId" | "checkpointId"
  >;
  readonly messageId: string;
  readonly text: string;
  readonly createdBy: "agent" | "user";
  readonly senderThreadId?: ThreadId;
}

/**
 * The one door task events take into an agent's conversation: the assistant task reactor and
 * autonomy wakes both send through it. It sends only news, and drops older task events about the
 * same thread still queued there, so a backlog never replays as a burst of stale reports.
 */
export class TaskEventNotices extends Context.Service<
  TaskEventNotices,
  {
    readonly send: (notice: TaskEventNotice) => Effect.Effect<NoticeOutcome>;
    /**
     * The id of the last notice when it already told the conversation everything `run` says (it
     * is that run's notice, or the run is no news against it); none otherwise.
     */
    readonly told: (
      input: Pick<TaskEventNotice, "threadId" | "run">,
    ) => Effect.Effect<Option.Option<string>>;
    /** Drops all but the newest queued task event per thread; heals backlogs from before this door. */
    readonly foldQueued: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/assistants/TaskEventNotices") {}

/**
 * Runs between the last notice and this one, newest first. They are runs no one was told about:
 * held for work that resumes them, quiet, or a send that failed; a few in practice.
 */
const WINDOW_RUNS = 50;

interface NoticeRow {
  readonly run_id: string;
  readonly status: string;
  readonly head_sha: string | null;
  readonly message_id: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  // Reactors call in from separate fibers; a judgment and its mark must not interleave.
  const lock = yield* Semaphore.make(1);

  const headOf = Effect.fn("TaskEventNotices.headOf")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return null;
    const cwd =
      shell.worktreePath ??
      Option.getOrUndefined(
        yield* projects.getById(shell.projectId).pipe(Effect.orElseSucceed(Option.none)),
      )?.workspaceRoot;
    if (cwd === undefined) return null;
    return yield* git.resolveCommit({ cwd, revision: "HEAD" }).pipe(
      Effect.map((result) => result.commitSha),
      Effect.orElseSucceed(() => null),
    );
  });

  const factsOf = Effect.fn("TaskEventNotices.factsOf")(function* (run: TaskEventNotice["run"]) {
    const records = yield* threads
      .getThreadRecords(run.threadId, ["messages", "checkpoints"], {
        messageIds: [run.userMessageId],
      })
      .pipe(Effect.orElseSucceed(() => ({ messages: [], checkpoints: [] })));
    const started = records.messages.find((message) => message.id === run.userMessageId);
    const checkpoint = records.checkpoints.find((entry) => entry.id === run.checkpointId);
    return {
      runId: run.id,
      status: run.status,
      headSha: yield* headOf(run.threadId),
      asked: started?.senderThreadId !== undefined,
      changedFiles: checkpoint?.status === "ready" ? checkpoint.files.length : 0,
    } satisfies RunFacts;
  });

  /** What the runs after the marked one and before `run` brought; none when unreadable. */
  const windowSince = Effect.fn("TaskEventNotices.windowSince")(function* (
    run: TaskEventNotice["run"],
    markedRunId: string | null,
  ) {
    const rows = yield* sql<{ readonly asked: number; readonly changed_files: number }>`
      SELECT
        COALESCE(MAX(json_extract(message.payload_json, '$.senderThreadId') IS NOT NULL), 0) AS asked,
        COALESCE(SUM(CASE WHEN checkpoint.status = 'ready'
          THEN json_array_length(checkpoint.payload_json, '$.files') END), 0) AS changed_files
      FROM (
        SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${run.threadId} AND status != 'rolled_back'
          AND ordinal < (
            SELECT ordinal FROM orchestration_v2_projection_runs WHERE run_id = ${run.id})
          AND ordinal > COALESCE((
            SELECT ordinal FROM orchestration_v2_projection_runs WHERE run_id = ${markedRunId}), -1)
        ORDER BY ordinal DESC
        LIMIT ${WINDOW_RUNS}
      ) AS run
      LEFT JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
      LEFT JOIN orchestration_v2_projection_checkpoints AS checkpoint
        ON checkpoint.checkpoint_id = json_extract(run.payload_json, '$.checkpointId')`.pipe(
      Effect.orElseSucceed(() => []),
    );
    return { asked: (rows[0]?.asked ?? 0) > 0, changedFiles: rows[0]?.changed_files ?? 0 };
  });

  const isTaskEvent = (message: {
    readonly id: string;
    readonly senderThreadId?: ThreadId | undefined;
  }) => message.id.startsWith(TASK_EVENT_MESSAGE_PREFIX) && message.senderThreadId !== undefined;

  /** Cancels the queued runs `pick` names, oldest first; best effort, never fails. */
  const dropQueued = Effect.fn("TaskEventNotices.dropQueued")(function* (
    threadId: ThreadId,
    pick: (
      queued: ReadonlyArray<{
        readonly runId: string;
        readonly message: { readonly id: string; readonly senderThreadId?: ThreadId | undefined };
      }>,
    ) => ReadonlyArray<string>,
  ) {
    const records = yield* threads
      .getThreadRecords(threadId, ["runs", "messages"], {
        runStatuses: ["queued"],
        messageRoles: ["user"],
      })
      .pipe(Effect.orElseSucceed(() => ({ runs: [], messages: [] })));
    const byId = new Map(records.messages.map((message) => [message.id, message]));
    const queued = records.runs
      .toSorted((a, b) => a.ordinal - b.ordinal)
      .flatMap((run) => {
        const message = byId.get(run.userMessageId);
        return message === undefined ? [] : [{ runId: run.id, message }];
      });
    for (const runId of pick(queued)) {
      yield* engine
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`task-notice-fold:${runId}`),
          threadId,
          runId: runId as OrchestrationV2Run["id"],
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("task notice: a queued event started before it could be folded", {
              runId,
              cause,
            }),
          ),
        );
    }
  });

  const markNotice = Effect.fn("TaskEventNotices.mark")(function* (
    notice: TaskEventNotice,
    row: NoticeRow,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO assistant_task_notices
        (thread_id, subject_thread_id, run_id, status, head_sha, message_id, updated_at)
      VALUES (${notice.threadId}, ${notice.run.threadId}, ${row.run_id}, ${row.status},
        ${row.head_sha}, ${row.message_id}, ${now})
      ON CONFLICT (thread_id, subject_thread_id) DO UPDATE SET
        run_id = excluded.run_id, status = excluded.status, head_sha = excluded.head_sha,
        message_id = excluded.message_id, updated_at = excluded.updated_at`;
  });

  /** Judges a run against the last notice; call under the lock. */
  const judge = Effect.fn("TaskEventNotices.judge")(function* (
    notice: Pick<TaskEventNotice, "threadId" | "run">,
    facts: RunFacts,
  ) {
    const rows = yield* sql<NoticeRow>`
      SELECT run_id, status, head_sha, message_id FROM assistant_task_notices
      WHERE thread_id = ${notice.threadId} AND subject_thread_id = ${notice.run.threadId}`;
    const previous = rows[0];
    const mark =
      previous === undefined
        ? undefined
        : { runId: previous.run_id, status: previous.status, headSha: previous.head_sha };
    const window = yield* windowSince(notice.run, previous?.run_id ?? null);
    const judged = {
      ...facts,
      asked: facts.asked || window.asked,
      changedFiles: facts.changedFiles + window.changedFiles,
    };
    return { previous, news: isNews(mark, judged) };
  });

  const told: TaskEventNotices["Service"]["told"] = Effect.fn("TaskEventNotices.told")(
    function* (input) {
      const facts = yield* factsOf(input.run);
      const { previous, news } = yield* lock.withPermits(1)(judge(input, facts));
      return previous === undefined || news ? Option.none() : Option.some(previous.message_id);
    },
    (effect) => effect.pipe(Effect.orElseSucceed(() => Option.none())),
  );

  const send: TaskEventNotices["Service"]["send"] = Effect.fn("TaskEventNotices.send")(
    function* (notice) {
      const facts = yield* factsOf(notice.run);
      return yield* lock
        .withPermits(1)(
          Effect.gen(function* () {
            const { previous, news } = yield* judge(notice, facts);
            if (!news) return "unchanged" as const;
            // The command id is the message id, so a send repeated after a crash lands once;
            // marking only after it succeeds never records an event nobody was told.
            const sent = yield* threads
              .sendToThread({
                projectId: notice.projectId,
                commandId: CommandId.make(notice.messageId),
                messageId: MessageId.make(notice.messageId),
                threadId: notice.threadId,
                ...(notice.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: notice.senderThreadId }),
                text: notice.text,
                attachments: [],
                mode: "queue",
                createdBy: notice.createdBy,
                creationSource: "server",
              })
              .pipe(Effect.result);
            if (sent._tag === "Failure") {
              yield* Effect.logWarning("task notice could not be sent", {
                threadId: notice.threadId,
                subjectThreadId: notice.run.threadId,
                cause: sent.failure,
              });
              return "failed" as const;
            }
            yield* markNotice(notice, {
              run_id: facts.runId,
              status: facts.status,
              head_sha: facts.headSha,
              message_id: notice.messageId,
            });
            yield* dropQueued(notice.threadId, (queued) =>
              queued
                .filter(
                  ({ message }) =>
                    message.id !== notice.messageId &&
                    (message.id === previous?.message_id ||
                      (isTaskEvent(message) && message.senderThreadId === notice.run.threadId)),
                )
                .map(({ runId }) => runId),
            );
            return "sent" as const;
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("task notice failed", { threadId: notice.threadId, cause }).pipe(
              Effect.as("failed" as const),
            ),
          ),
        );
    },
  );

  const foldQueued: TaskEventNotices["Service"]["foldQueued"] = (threadId) =>
    lock.withPermits(1)(
      dropQueued(threadId, (queued) => {
        const events = queued.filter(({ message }) => isTaskEvent(message));
        return events
          .filter(
            ({ message }, index) =>
              events.findLastIndex(
                (other) => other.message.senderThreadId === message.senderThreadId,
              ) !== index,
          )
          .map(({ runId }) => runId);
      }),
    );

  return { send, told, foldQueued } satisfies TaskEventNotices["Service"];
});

export const layer = Layer.effect(TaskEventNotices, make);
