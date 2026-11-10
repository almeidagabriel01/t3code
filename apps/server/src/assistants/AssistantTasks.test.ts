import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type AssistantId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { assistantNote } from "./assistantNote.ts";
import * as Directory from "./AssistantDirectory.ts";
import * as Tasks from "./AssistantTasks.ts";

const layer = Layer.mergeAll(Tasks.layer, Directory.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const seed = (id: string, instructions = "") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistants
        (assistant_id, handle, name, project_id, instructions, tool_access, thread_id, created_at, updated_at)
      VALUES (${id}, ${id}, ${id.toUpperCase()}, 'p1', ${instructions}, 'full', ${`assistant:${id}:1`},
        '2026-01-01', '2026-01-01')`;
  });

const task = (threadId: string, assistantId: string) => ({
  threadId: ThreadId.make(threadId),
  assistantId: assistantId as AssistantId,
  projectId: ProjectId.make("p1"),
  title: `Task ${threadId}`,
  createdAt: "2026-01-02T00:00:00.000Z",
});

it.effect("a launch from an assistant links its thread, and a repeat keeps the first link", () =>
  Effect.gen(function* () {
    yield* seed("jarvis", "Answer in English.");
    const tasks = yield* Tasks.AssistantTasks;
    const subscription = yield* PubSub.subscribe(tasks.changes);
    const linked = yield* Tasks.linkTaskLaunch({
      callerThreadId: ThreadId.make("assistant:jarvis:1"),
      threadId: ThreadId.make("thread-a"),
      projectId: ProjectId.make("p1"),
      title: "Add retry",
    });
    assert.isTrue(linked);
    yield* Tasks.linkTaskLaunch({
      callerThreadId: ThreadId.make("assistant:jarvis:1"),
      threadId: ThreadId.make("thread-a"),
      projectId: ProjectId.make("p1"),
      title: "Renamed",
    });
    const list = yield* tasks.list;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]?.title, "Add retry");
    assert.strictEqual(list[0]?.assistantId, "jarvis");
    assert.strictEqual((yield* PubSub.take(subscription)).threadId, "thread-a");

    // A thread that is no assistant's, and a caller with no thread, link nothing.
    for (const callerThreadId of [ThreadId.make("thread-plain"), undefined]) {
      assert.isFalse(
        yield* Tasks.linkTaskLaunch({
          callerThreadId,
          threadId: ThreadId.make("thread-b"),
          projectId: ProjectId.make("p1"),
          title: "No",
        }),
      );
    }
    assert.strictEqual((yield* tasks.list).length, 1);

    yield* Tasks.unlinkTaskLaunch(ThreadId.make("thread-a"));
    assert.strictEqual((yield* tasks.list).length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("rows written before dismissing existed read as not dismissed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* Tasks.AssistantTasks;
    yield* sql`
      INSERT INTO assistant_tasks (thread_id, assistant_id, project_id, title, created_at)
      VALUES ('old', 'a', 'p1', 'Old', '2026-01-01T00:00:00.000Z')`;
    const old = Option.getOrNull(yield* tasks.forThread(ThreadId.make("old")));
    assert.isNull(old?.dismissedAt);
    const subscription = yield* PubSub.subscribe(tasks.changes);
    const dismissed = yield* tasks.setDismissed(ThreadId.make("old"), "2026-02-01T00:00:00.000Z");
    assert.strictEqual(Option.getOrNull(dismissed)?.dismissedAt, "2026-02-01T00:00:00.000Z");
    assert.strictEqual((yield* PubSub.take(subscription)).dismissedAt, "2026-02-01T00:00:00.000Z");
    assert.isTrue(Option.isNone(yield* tasks.setDismissed(ThreadId.make("none"), null)));
  }).pipe(Effect.provide(layer)),
);

it.effect("tasks are per assistant, and deleting an assistant removes its links only", () =>
  Effect.gen(function* () {
    const tasks = yield* Tasks.AssistantTasks;
    yield* tasks.link(task("t1", "a"));
    yield* tasks.link(task("t2", "b"));
    assert.strictEqual(
      Option.getOrNull(yield* tasks.forThread(ThreadId.make("t1")))?.assistantId,
      "a",
    );
    yield* tasks.removeFor("a");
    assert.deepEqual(
      (yield* tasks.list).map((entry) => entry.threadId),
      ["t2"],
    );
    assert.isTrue(Option.isNone(yield* tasks.forThread(ThreadId.make("t1"))));
  }).pipe(Effect.provide(layer)),
);

it.effect("a task thread's turns carry its assistant's instructions, and no one else's do", () =>
  Effect.gen(function* () {
    yield* seed("jarvis", "Answer in English.");
    const tasks = yield* Tasks.AssistantTasks;
    const directory = yield* Directory.AssistantDirectory;
    yield* tasks.link(task("thread-a", "jarvis"));
    const note = yield* assistantNote(Option.some(directory), ThreadId.make("thread-a"), "go");
    assert.include(note, '<t3_assistant_task assistant="JARVIS" handle="jarvis">');
    assert.include(note, "Answer in English.");
    assert.strictEqual(
      yield* assistantNote(Option.some(directory), ThreadId.make("thread-a"), "/compact"),
      "",
    );
    assert.strictEqual(
      yield* assistantNote(Option.some(directory), ThreadId.make("thread-plain"), "go"),
      "",
    );
    // An assistant's own conversation is never a task thread.
    assert.isTrue(Option.isNone(yield* directory.taskOwner(ThreadId.make("assistant:jarvis:1"))));
  }).pipe(Effect.provide(layer)),
);

it.effect("the note every assistant carries says when to launch work and how to follow it", () =>
  Effect.gen(function* () {
    yield* seed("jarvis");
    const directory = yield* Directory.AssistantDirectory;
    const note = yield* assistantNote(
      Option.some(directory),
      ThreadId.make("assistant:jarvis:1"),
      "go",
    );
    assert.include(note, "t3_thread_launch");
    assert.include(note, "woken when it finishes");
  }).pipe(Effect.provide(layer)),
);
