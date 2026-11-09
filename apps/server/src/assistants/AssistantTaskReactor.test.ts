import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type AssistantId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Reactor from "./AssistantTaskReactor.ts";
import * as Tasks from "./AssistantTasks.ts";

const taskThread = ThreadId.make("thread-task");

const runEvent = (threadId: ThreadId, status: string, type = "run.updated") =>
  ({
    type,
    payload: { id: `run-${status}`, threadId, status, userMessageId: "m1" },
  }) as never as OrchestrationV2DomainEvent;

const harness = (options: { readonly failSend?: boolean } = {}) => {
  const sends: Array<Record<string, unknown>> = [];
  const layer = Reactor.layer.pipe(
    Layer.provideMerge(Tasks.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.empty,
          getThreadShell: () => Effect.succeed({ title: "Add retry" } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              messages: [{ text: "Done: retry added" }, { text: "  " }],
            } as never),
          sendToThread: (input) =>
            options.failSend === true
              ? Effect.fail(new Error("send failed") as never)
              : Effect.sync(() => void sends.push(input as never)).pipe(Effect.as({} as never)),
        }),
      ),
    ),
  );
  return { sends, layer };
};

const setup = (archived = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistants
        (assistant_id, handle, name, project_id, tool_access, thread_id, archived_at, created_at, updated_at)
      VALUES ('jarvis', 'jarvis', 'Jarvis', 'assistants-home', 'full', 'assistant:jarvis:1',
        ${archived ? "now" : null}, '2026-01-01', '2026-01-01')`;
    yield* (yield* Tasks.AssistantTasks).link({
      threadId: taskThread,
      assistantId: "jarvis" as AssistantId,
      projectId: ProjectId.make("p1"),
      title: "Add retry",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
  });

it.effect(
  "a task run that ends wakes its assistant once, with the thread and its last message",
  () => {
    const { sends, layer } = harness();
    return Effect.gen(function* () {
      yield* setup();
      const reactor = yield* Reactor.AssistantTaskReactor;
      yield* reactor.handle(runEvent(taskThread, "completed"));
      yield* reactor.handle(runEvent(taskThread, "completed", "run.created"));
      assert.strictEqual(sends.length, 2);
      const [sent] = sends;
      // Both events name the same run, so they send the same message and command id.
      assert.strictEqual(sends[0]?.messageId, sends[1]?.messageId);
      assert.strictEqual(sent?.messageId, "assistant-task:run-completed");
      assert.strictEqual(sent?.threadId, "assistant:jarvis:1");
      // The send targets the assistant's thread, so it names the assistant's project, not the task's.
      assert.strictEqual(sent?.projectId, "assistants-home");
      assert.strictEqual(sent?.senderThreadId, taskThread);
      assert.strictEqual(sent?.mode, "queue");
      const text = String(sent?.text);
      assert.include(text, "finished");
      assert.include(text, "Done: retry added");
      assert.include(text, "t3_thread_send");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a failed run says so", () => {
  const { sends, layer } = harness();
  return Effect.gen(function* () {
    yield* setup();
    yield* (yield* Reactor.AssistantTaskReactor).handle(runEvent(taskThread, "failed"));
    assert.include(String(sends[0]?.text), "failed");
  }).pipe(Effect.provide(layer));
});

it.effect("a run still going, another thread, and an archived assistant wake no one", () => {
  const { sends, layer } = harness();
  return Effect.gen(function* () {
    yield* setup(true);
    const reactor = yield* Reactor.AssistantTaskReactor;
    yield* reactor.handle(runEvent(taskThread, "running"));
    yield* reactor.handle(runEvent(ThreadId.make("thread-plain"), "completed"));
    yield* reactor.handle(runEvent(taskThread, "completed"));
    yield* reactor.handle({ type: "thread.created", threadId: taskThread } as never);
    assert.strictEqual(sends.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a wake that cannot be sent is logged and does not stop the reactor", () => {
  const { layer } = harness({ failSend: true });
  return Effect.gen(function* () {
    yield* setup();
    yield* (yield* Reactor.AssistantTaskReactor).handle(runEvent(taskThread, "completed"));
  }).pipe(Effect.provide(layer));
});

it("the wake text names the outcome and works without a last message", () => {
  const text = Reactor.taskWakeText({
    title: "Add retry",
    threadId: taskThread,
    status: "interrupted",
    lastMessage: null,
  });
  assert.include(text, "interrupted");
  assert.notInclude(text, "last message");
});
