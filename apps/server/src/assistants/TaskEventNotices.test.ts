import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
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
  readonly message: { readonly id: string; readonly senderThreadId?: ThreadId };
}

const harness = () => {
  const state = {
    head: "sha-1" as string | null,
    /** The message that started each run, by message id. */
    started: new Map<string, { readonly id: string; readonly senderThreadId?: ThreadId }>(),
    /** Changed files per checkpoint id. */
    files: new Map<string, number>(),
    /** The capture effect each run's end enqueued, by run id. */
    captures: new Map<string, "pending" | "running" | "succeeded" | "failed" | "cancelled">(),
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
                    return {} as never;
                  }),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: (commandId) =>
            Effect.sync(() => {
              const runId = commandId.replace("command:effect:checkpoint.capture:", "");
              const status = state.captures.get(runId);
              return status === undefined ? [] : [{ status } as never];
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

it.effect("a run with no diff, no new commit and the same status wakes no one", () => {
  const h = harness();
  return Effect.gen(function* () {
    assert.strictEqual(yield* launched(h), "sent");
    // A background command's wake, a restart continuation, an idle compaction: no message of an agent.
    for (const id of ["r2", "r3", "r4"]) {
      assert.strictEqual(yield* (yield* TaskEventNotices).send(notice(run(id))), "unchanged");
    }
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

it.effect.each([
  {
    name: "completed with its checkpoint",
    status: "completed",
    capture: undefined,
    expected: "sent",
  },
  { name: "failed", status: "failed", capture: undefined, expected: "sent" },
  { name: "cancelled from the queue", status: "cancelled", capture: undefined, expected: "sent" },
  {
    name: "cancelled while capturing",
    status: "cancelled",
    capture: "pending",
    expected: "pending",
  },
  {
    name: "interrupted while capturing",
    status: "interrupted",
    capture: "running",
    expected: "pending",
  },
  // Captured, but the run it re-sends has not reached the door yet.
  {
    name: "interrupted and captured",
    status: "interrupted",
    capture: "succeeded",
    expected: "pending",
  },
  {
    name: "interrupted with nowhere to capture",
    status: "interrupted",
    capture: undefined,
    expected: "sent",
  },
  {
    name: "interrupted whose capture failed",
    status: "interrupted",
    capture: "failed",
    expected: "sent",
  },
] as const)("a $name run without a checkpoint is $expected", ({ status, capture, expected }) => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    // Changed files make each judged run news, so only waiting can hold it back.
    h.state.files.set("checkpoint:r2", 1);
    if (capture !== undefined) h.state.captures.set("r2", capture);
    const subject = run("r2", {
      status,
      checkpointId: status === "completed" ? "checkpoint:r2" : null,
    });
    assert.strictEqual(yield* (yield* TaskEventNotices).send(notice(subject)), expected);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a stopped run waits for its checkpoint, then is told once", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* launched(h);
    const notices = yield* TaskEventNotices;
    h.state.captures.set("r2", "pending");
    const stopped = run("r2", { status: "interrupted", checkpointId: null });
    assert.strictEqual(yield* notices.send(notice(stopped)), "pending");
    assert.strictEqual(
      yield* notices.send(notice({ ...stopped, checkpointId: "checkpoint:r2" as never })),
      "sent",
    );
    assert.strictEqual(
      yield* notices.send(notice({ ...stopped, checkpointId: "checkpoint:r2" as never })),
      "unchanged",
    );
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
