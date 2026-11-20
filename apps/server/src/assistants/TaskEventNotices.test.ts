import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { TaskEventNotices, layer as noticesLayer } from "./TaskEventNotices.ts";

const assistantThread = ThreadId.make("assistant:jarvis:1");
const taskThread = ThreadId.make("mcp:launch:task");
const otherTask = ThreadId.make("mcp:launch:other");

interface QueuedEvent {
  readonly runId: string;
  readonly ordinal: number;
  readonly message: {
    readonly id: string;
    readonly text?: string;
    readonly senderThreadId?: ThreadId;
  };
}

/** `busy`: the assistant is in a turn, so every notice sent waits in its queue. */
const harness = (options: { readonly busy?: boolean } = {}) => {
  const state = {
    head: "sha-1" as string | null,
    /** The message that started each run, by message id. */
    started: new Map<string, { readonly id: string; readonly senderThreadId?: ThreadId }>(),
    /** Changed files per checkpoint id. */
    files: new Map<string, number>(),
    queued: [] as Array<QueuedEvent>,
    failSend: false,
    dieSend: false,
    failShell: false,
    failRecords: false,
  };
  const sends: Array<{ readonly messageId: string; readonly text: string }> = [];
  const cancelled: Array<string> = [];
  const layer = noticesLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "queued-run.cancel") {
                cancelled.push(command.runId);
                state.queued = state.queued.filter((entry) => entry.runId !== command.runId);
              }
              return {} as never;
            }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            state.failShell
              ? Effect.fail(new Error("no shell") as never)
              : Effect.succeed({ projectId: ProjectId.make("p1"), worktreePath: "/repo" } as never),
          getThreadRecords: (threadId, _fields, filter) =>
            state.failRecords
              ? Effect.fail(new Error("no records") as never)
              : Effect.succeed({
                  checkpoints: [...state.files].map(([id, count]) => ({
                    id,
                    status: "ready",
                    files: Array.from({ length: count }, () => ({})),
                  })),
                  messages:
                    threadId === assistantThread
                      ? state.queued.map((entry) => entry.message)
                      : (filter?.messageIds ?? []).flatMap((id) => {
                          const message = state.started.get(id);
                          return message === undefined ? [] : [message];
                        }),
                  runs: state.queued.map((entry) => ({
                    id: entry.runId,
                    ordinal: entry.ordinal,
                    userMessageId: entry.message.id,
                  })),
                } as never),
          sendToThread: (input) =>
            state.dieSend
              ? Effect.die("send blew up")
              : state.failSend
                ? Effect.fail(new Error("send failed") as never)
                : Effect.sync(() => {
                    sends.push({ messageId: input.messageId, text: input.text });
                    if (options.busy === true) {
                      state.queued.push({
                        runId: `queued:${input.messageId}`,
                        ordinal: state.queued.length + 1,
                        message: {
                          id: input.messageId,
                          text: input.text,
                          ...(input.senderThreadId === undefined
                            ? {}
                            : { senderThreadId: input.senderThreadId }),
                        },
                      });
                    }
                    return {} as never;
                  }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedNone,
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveCommit: () =>
            state.head === null
              ? Effect.fail(new Error("not a repository") as never)
              : Effect.succeed({ commitSha: state.head } as never),
        }),
      ),
    ),
  );
  return { state, sends, cancelled, layer };
};

type Run = TaskEventNotice["run"];
type TaskEventNotice = Parameters<TaskEventNotices["Service"]["send"]>[0];

const run = (
  id: string,
  options: {
    readonly status?: OrchestrationV2Run["status"];
    readonly checkpointId?: string | null;
    readonly startedBy?: string;
    readonly threadId?: ThreadId;
  } = {},
): Run =>
  ({
    id,
    threadId: options.threadId ?? taskThread,
    status: options.status ?? "completed",
    userMessageId: options.startedBy ?? `message:${id}`,
    checkpointId: options.checkpointId === undefined ? `checkpoint:${id}` : options.checkpointId,
  }) as Run;

const notice = (subject: Run): TaskEventNotice => ({
  threadId: assistantThread,
  projectId: ProjectId.make("assistants-home"),
  run: subject,
  messageId: `assistant-task:${subject.id}`,
  text: `Task ${subject.id} ${subject.status}.`,
  createdBy: "agent",
  senderThreadId: subject.threadId,
});

/** The run the assistant launched the task with: an agent's message, so always news. */
const launched = (h: ReturnType<typeof harness>) =>
  Effect.gen(function* () {
    h.state.started.set("launch", { id: "launch", senderThreadId: assistantThread });
    h.state.files.set("checkpoint:r1", 4);
    return yield* (yield* TaskEventNotices).send(notice(run("r1", { startedBy: "launch" })));
  });

/** The task's runs as the projection holds them: what started each, and its checkpoint's files. */
const projected = (
  runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly askedBy?: ThreadId;
    readonly files?: number;
  }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const entry of runs) {
      const payload = {
        userMessageId: `message:${entry.id}`,
        checkpointId: `checkpoint:${entry.id}`,
      };
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${entry.id}, ${taskThread}, ${entry.ordinal}, 'codex', 'completed', '2026-01-01',
          ${JSON.stringify(payload)})`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${payload.userMessageId}, ${taskThread}, ${entry.id}, 'user', 0, '2026-01-01',
          '2026-01-01', ${JSON.stringify(entry.askedBy === undefined ? {} : { senderThreadId: entry.askedBy })})`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_checkpoints
          (checkpoint_id, thread_id, scope_id, run_id, node_id, ordinal_within_scope, status,
            captured_at, payload_json)
        VALUES (${payload.checkpointId}, ${taskThread}, 'scope', ${entry.id}, 'node', ${entry.ordinal},
          'ready', '2026-01-01', ${JSON.stringify({ files: Array.from({ length: entry.files ?? 0 }, () => ({})) })})`;
    }
  });

it.effect("a run with no diff, no new commit and the same status wakes no one", () => {
  const h = harness();
  return Effect.gen(function* () {
    const notices = yield* TaskEventNotices;
    // Nothing was told before the first notice.
    assert.isTrue(Option.isNone(yield* notices.told(notice(run("r1", { startedBy: "launch" })))));
    assert.strictEqual(yield* launched(h), "sent");
    // A background command's wake, a restart continuation, an idle compaction: no message of an agent.
    for (const id of ["r2", "r3", "r4"]) {
      assert.strictEqual(yield* notices.send(notice(run(id))), "unchanged");
      // The notice of r1 already said all of it, so reading r1's notice delivers this run too.
      assert.deepStrictEqual(
        yield* notices.told(notice(run(id))),
        Option.some("assistant-task:r1"),
      );
    }
    h.state.files.set("checkpoint:r5", 2);
    assert.isTrue(Option.isNone(yield* notices.told(notice(run("r5")))));
    assert.deepStrictEqual(
      h.sends.map((sent) => sent.messageId),
      ["assistant-task:r1"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("the same run is told once, whichever event or path reports it", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    const notices = yield* TaskEventNotices;
    assert.strictEqual(
      yield* notices.send(notice(run("r1", { startedBy: "launch" }))),
      "unchanged",
    );
    // A watch on the same run arrives under its own message id.
    assert.strictEqual(
      yield* notices.send({
        ...notice(run("r1", { startedBy: "launch" })),
        messageId: "autonomy-wake:run:r1:watch:w1:jarvis",
      }),
      "unchanged",
    );
    assert.lengthOf(h.sends, 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([
  {
    name: "an answer to an agent's message",
    arrange: (h: ReturnType<typeof harness>) =>
      h.state.started.set("ask", { id: "ask", senderThreadId: assistantThread }),
    subject: run("r2", { startedBy: "ask" }),
  },
  {
    name: "changed files",
    arrange: (h: ReturnType<typeof harness>) => h.state.files.set("checkpoint:r2", 1),
    subject: run("r2"),
  },
  {
    name: "a new commit",
    arrange: (h: ReturnType<typeof harness>) => void (h.state.head = "sha-2"),
    subject: run("r2"),
  },
  {
    name: "another end state",
    arrange: () => undefined,
    subject: run("r2", { status: "failed" }),
  },
])("a run with $name is news", ({ arrange, subject }) => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    arrange(h);
    assert.strictEqual(yield* (yield* TaskEventNotices).send(notice(subject)), "sent");
    assert.lengthOf(h.sends, 2);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a new event drops older events about the same task still queued, old ones included",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* launched(h);
      h.state.queued = [
        // Queued before this door existed, then the event it replaced.
        {
          runId: "q1",
          ordinal: 1,
          message: { id: "assistant-task:old", senderThreadId: taskThread },
        },
        {
          runId: "q2",
          ordinal: 2,
          message: { id: "assistant-task:r1", senderThreadId: taskThread },
        },
        { runId: "q3", ordinal: 3, message: { id: "user-message" } },
        { runId: "q4", ordinal: 4, message: { id: "assistant-task:x", senderThreadId: otherTask } },
        {
          runId: "q5",
          ordinal: 5,
          message: { id: "assistant-task:r2", senderThreadId: taskThread },
        },
      ];
      h.state.files.set("checkpoint:r2", 2);
      assert.strictEqual(yield* (yield* TaskEventNotices).send(notice(run("r2"))), "sent");
      assert.deepStrictEqual(h.cancelled, ["q1", "q2"]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a backlog keeps only the newest queued event per task", () => {
  const h = harness();
  return Effect.gen(function* () {
    h.state.queued = [
      { runId: "q2", ordinal: 2, message: { id: "assistant-task:b", senderThreadId: taskThread } },
      { runId: "q1", ordinal: 1, message: { id: "assistant-task:a", senderThreadId: taskThread } },
      { runId: "q3", ordinal: 3, message: { id: "assistant-task:c", senderThreadId: otherTask } },
      { runId: "q4", ordinal: 4, message: { id: "assistant-task:d", senderThreadId: taskThread } },
      { runId: "q5", ordinal: 5, message: { id: "user-message" } },
    ];
    yield* (yield* TaskEventNotices).foldQueued(assistantThread);
    assert.deepStrictEqual(h.cancelled, ["q1", "q2"]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a stopped run is judged at once, and told when its checkpoint brings changes", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    const notices = yield* TaskEventNotices;
    const stopped = (id: string, checkpointId: string | null = null) =>
      notice(run(id, { status: "interrupted", checkpointId }));
    // The capture may fail or end without re-sending the run, so nothing waits on it.
    assert.strictEqual(yield* notices.send(stopped("r2")), "sent");
    assert.strictEqual(yield* notices.send(stopped("r2", "checkpoint:r2")), "unchanged");
    h.state.files.set("checkpoint:r3", 1);
    assert.strictEqual(yield* notices.send(stopped("r3")), "unchanged");
    assert.strictEqual(yield* notices.send(stopped("r3", "checkpoint:r3")), "sent");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a send that dies before its mark is told on the next try", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    const notices = yield* TaskEventNotices;
    h.state.files.set("checkpoint:r2", 1);
    h.state.dieSend = true;
    assert.strictEqual(yield* notices.send(notice(run("r2"))), "failed");
    h.state.dieSend = false;
    assert.strictEqual(yield* notices.send(notice(run("r2"))), "sent");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a send that fails gives the mark back, so the event is told on the next try", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    const notices = yield* TaskEventNotices;
    h.state.files.set("checkpoint:r2", 1);
    h.state.failSend = true;
    assert.strictEqual(yield* notices.send(notice(run("r2"))), "failed");
    h.state.failSend = false;
    assert.strictEqual(yield* notices.send(notice(run("r2"))), "sent");
    // Judged against r1 again, not the failed attempt: r3 without changes stays quiet.
    assert.strictEqual(yield* notices.send(notice(run("r3"))), "unchanged");
  }).pipe(Effect.provide(h.layer));
});

it.effect("unreadable thread facts count as no facts, and a defect in the door says failed", () => {
  const h = harness();
  return Effect.gen(function* () {
    const notices = yield* TaskEventNotices;
    // No head to compare: an unreadable repository, then an unreadable shell.
    h.state.head = null;
    assert.strictEqual(yield* launched(h), "sent");
    assert.strictEqual(yield* notices.send(notice(run("r2"))), "unchanged");
    h.state.failShell = true;
    assert.strictEqual(yield* notices.send(notice(run("r3"))), "unchanged");
    // Unreadable records: no diff, no asker, nothing to wait for, and queued events stay put.
    h.state.failRecords = true;
    assert.strictEqual(yield* notices.send(notice(run("r4"))), "unchanged");
    assert.strictEqual(
      yield* notices.send(notice(run("r5", { status: "failed", checkpointId: null }))),
      "sent",
    );
    yield* notices.foldQueued(assistantThread);
    assert.deepStrictEqual(h.cancelled, []);
    h.state.dieSend = true;
    assert.strictEqual(yield* notices.send(notice(run("r6", { status: "interrupted" }))), "failed");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a run that resumes a held one carries what the held run did", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    // r2 was asked for and changed files, then parked on subagents, so no one was told; r3 resumes
    // it and ends with nothing of its own.
    yield* projected([
      { id: "r1", ordinal: 1, askedBy: assistantThread, files: 4 },
      { id: "r2", ordinal: 2, askedBy: assistantThread, files: 3 },
      { id: "r3", ordinal: 3 },
    ]);
    assert.strictEqual(yield* (yield* TaskEventNotices).send(notice(run("r3"))), "sent");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a told run closes the window: what came before it is never told again", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    const notices = yield* TaskEventNotices;
    yield* projected([
      { id: "r1", ordinal: 1, askedBy: assistantThread, files: 4 },
      { id: "r2", ordinal: 2, askedBy: assistantThread, files: 3 },
      { id: "r3", ordinal: 3 },
      { id: "r4", ordinal: 4 },
    ]);
    assert.strictEqual(yield* notices.send(notice(run("r3"))), "sent");
    assert.strictEqual(yield* notices.send(notice(run("r4"))), "unchanged");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a send that fails keeps the window open, so the next run end still tells it", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    const notices = yield* TaskEventNotices;
    yield* projected([
      { id: "r1", ordinal: 1, askedBy: assistantThread, files: 4 },
      { id: "r2", ordinal: 2, askedBy: assistantThread, files: 3 },
      { id: "r3", ordinal: 3 },
    ]);
    h.state.started.set("ask", { id: "ask", senderThreadId: assistantThread });
    h.state.files.set("checkpoint:r2", 3);
    h.state.failSend = true;
    assert.strictEqual(yield* notices.send(notice(run("r2", { startedBy: "ask" }))), "failed");
    h.state.failSend = false;
    assert.strictEqual(yield* notices.send(notice(run("r3"))), "sent");
  }).pipe(Effect.provide(h.layer));
});

const INSTRUCTION = "If this tells the user nothing new, reply with exactly NO_REPLY and stop.";

/** A task notice as the task reactor sends it: a headline linking the task, then the instruction. */
const taskNotice = (subject: Run): TaskEventNotice => ({
  ...notice(subject),
  text: `Task ${formatThreadLink({ environmentId: null, threadId: subject.threadId }, subject.id)} finished.`,
  instruction: INSTRUCTION,
});

/** Agent-started runs, so each one is news. */
const asked = (h: ReturnType<typeof harness>, id: string, threadId: ThreadId) => {
  h.state.started.set(`ask:${id}`, { id: `ask:${id}`, senderThreadId: assistantThread });
  return run(id, { threadId, startedBy: `ask:${id}` });
};

const marks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly subject_thread_id: string; readonly message_id: string }>`
    SELECT subject_thread_id, message_id FROM assistant_task_notices ORDER BY subject_thread_id`;
});

const queuedTexts = (h: ReturnType<typeof harness>) =>
  h.state.queued.map((entry) => entry.message.text ?? "");

it.effect("tasks that end while the assistant is busy wait as one notice, each one marked", () => {
  const h = harness({ busy: true });
  return Effect.gen(function* () {
    const notices = yield* TaskEventNotices;
    assert.strictEqual(yield* notices.send(taskNotice(asked(h, "a1", taskThread))), "sent");
    assert.strictEqual(yield* notices.send(taskNotice(asked(h, "b1", otherTask))), "sent");
    // The first one is folded into the second: one queued turn tells both, newest first.
    assert.deepStrictEqual(h.cancelled, ["queued:assistant-task:a1"]);
    const [text = ""] = queuedTexts(h);
    assert.lengthOf(h.state.queued, 1);
    assert.match(text, /^Task \[b1\][\s\S]*Task \[a1\]/);
    assert.strictEqual(text.split(INSTRUCTION).length, 2);
    assert.isTrue(text.endsWith(INSTRUCTION));
    const merged = h.state.queued[0]!.message.id;
    assert.match(merged, /^assistant-task:merged:/);
    assert.deepStrictEqual(yield* marks, [
      { subject_thread_id: otherTask, message_id: merged },
      { subject_thread_id: taskThread, message_id: merged },
    ]);
    // A third task joins the same turn, under an id that names all three runs.
    const third = ThreadId.make("mcp:launch:third");
    yield* notices.send(taskNotice(asked(h, "c1", third)));
    assert.lengthOf(h.state.queued, 1);
    assert.notStrictEqual(h.state.queued[0]!.message.id, merged);
    assert.match(queuedTexts(h)[0]!, /^Task \[c1\][\s\S]*Task \[b1\][\s\S]*Task \[a1\]/);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a task told again replaces its own section, and a run with no news opens no turn",
  () => {
    const h = harness({ busy: true });
    return Effect.gen(function* () {
      const notices = yield* TaskEventNotices;
      yield* notices.send(taskNotice(asked(h, "a1", taskThread)));
      yield* notices.send(taskNotice(asked(h, "b1", otherTask)));
      yield* notices.send(taskNotice(asked(h, "a2", taskThread)));
      const [text = ""] = queuedTexts(h);
      assert.lengthOf(h.state.queued, 1);
      assert.match(text, /^Task \[a2\][\s\S]*Task \[b1\]/);
      assert.notInclude(text, "Task [a1]");
      // The same run again is no news: nothing is sent and the queued turn stays as it is.
      const sent = h.sends.length;
      assert.strictEqual(yield* notices.send(taskNotice(run("a2"))), "unchanged");
      assert.strictEqual(h.sends.length, sent);
      assert.lengthOf(h.state.queued, 1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("one task alone keeps its own id, and a replay of a merge lands on the same id", () => {
  const first = harness({ busy: true });
  const second = harness({ busy: true });
  const mergedOf = (h: ReturnType<typeof harness>) =>
    Effect.gen(function* () {
      const notices = yield* TaskEventNotices;
      yield* notices.send(taskNotice(asked(h, "a1", taskThread)));
      assert.strictEqual(h.state.queued[0]?.message.id, "assistant-task:a1");
      yield* notices.send(taskNotice(asked(h, "b1", otherTask)));
      return h.state.queued[0]!.message.id;
    }).pipe(Effect.provide(h.layer));
  return Effect.gen(function* () {
    assert.strictEqual(yield* mergedOf(first), yield* mergedOf(second));
  });
});
