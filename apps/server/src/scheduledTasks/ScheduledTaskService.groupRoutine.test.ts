import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { AssistantGroupGate } from "../assistants/AssistantGroupGate.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const input = (
  id: string,
  extra: Partial<ScheduledTaskUpsertInput> = {},
): ScheduledTaskUpsertInput => ({
  id: ScheduledTaskId.make(id),
  title: id,
  prompt: `@ada ${id}`,
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project:test"),
  assistantTeamId: "team:1",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  ...extra,
});

const harness = Effect.gen(function* () {
  const posts: string[] = [];
  const notes: string[] = [];
  const posted = yield* Deferred.make<void>();
  const gate = Layer.succeed(AssistantGroupGate, {
    post: (post) =>
      Effect.sync(() => void posts.push(post.label)).pipe(
        Effect.andThen(
          post.label === "task:sentinel" ? Deferred.succeed(posted, undefined) : Effect.void,
        ),
      ),
    note: (note) => Effect.sync(() => void notes.push(note.text)),
    install: () => Effect.void,
  });
  const layer = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        Scheduler.layer,
        gate,
      ),
    ),
  );
  return { posts, notes, posted, layer };
});

it.effect("a group routine leaves a chat line for add, edit, pause, resume and delete", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const { notes, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(input("task:a"));
      yield* TestClock.adjust("1 second");
      yield* service.upsert({ ...input("task:a"), requireExisting: true, title: "Renamed" });
      // Saving the same thing again, as a retry does, adds no line.
      yield* service.upsert({ ...input("task:a"), requireExisting: true, title: "Renamed" });
      yield* TestClock.adjust("1 second");
      yield* service.setEnabled({ id: task.id, enabled: false });
      yield* TestClock.adjust("1 second");
      // Saving with the switch flipped is a resume, not an edit.
      yield* service.upsert({ ...input("task:a"), requireExisting: true, title: "Renamed" });
      yield* TestClock.adjust("1 second");
      yield* service.delete({ id: task.id });
      // A thread-bound task leaves no group line.
      yield* service.upsert(input("task:thread", { assistantTeamId: null }));
      assert.deepEqual(notes, [
        "Added routine 'task:a'",
        "Edited routine 'Renamed'",
        "Paused routine 'Renamed'",
        "Resumed routine 'Renamed'",
        "Deleted routine 'Renamed'",
      ]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a routine stops at its run limit, says so, and needs a higher limit to run again", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const { notes, posts, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(input("task:limited", { maxRuns: 2 }));
      assert.equal(task.maxRuns, 2);
      const first = yield* service.runNow({ id: task.id });
      assert.deepEqual([first.task.enabled, first.task.runCount], [true, 1]);
      yield* TestClock.adjust("1 second");
      const last = yield* service.runNow({ id: task.id });
      assert.deepEqual(
        [last.task.enabled, last.task.nextRunAt, last.task.runCount],
        [false, null, 2],
      );
      assert.deepEqual(posts, ["task:limited", "task:limited"]);
      assert.include(notes.at(-1), "reached its run limit of 2");
      const stored = (yield* service.list()).tasks[0]!;
      assert.deepEqual([stored.enabled, stored.nextRunAt], [false, null]);
      const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.include(refused.message, "its limit");
      const resumed = yield* service.setEnabled({ id: task.id, enabled: true }).pipe(Effect.flip);
      assert.include(resumed.message, "Raise the limit");
      const saved = yield* service
        .upsert({ ...input("task:limited"), maxRuns: 2, requireExisting: true })
        .pipe(Effect.flip);
      assert.include(saved.message, "Raise the limit");
      // Raising the limit and turning it on in one save lets it run again.
      const raised = yield* service.upsert({
        ...input("task:limited", { maxRuns: 3 }),
        requireExisting: true,
      });
      assert.deepEqual([raised.task.enabled, raised.task.maxRuns], [true, 3]);
      // Omitting the limit keeps it; null removes it.
      const kept = yield* service.upsert({ ...input("task:limited"), requireExisting: true });
      assert.equal(kept.task.maxRuns, 3);
      const cleared = yield* service.upsert({
        ...input("task:limited", { maxRuns: null }),
        requireExisting: true,
      });
      assert.equal(cleared.task.maxRuns, undefined);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["skip", "once"] as const)(
  "a daily routine missed while the server was off is run once only with policy %s",
  (policy) =>
    Effect.gen(function* () {
      const dueAt = DateTime.makeZonedUnsafe(
        { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      );
      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);
      const { posts, posted, layer } = yield* harness;
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const daily = input("task:daily", {
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
          ...(policy === "once" ? { missedRunPolicy: "once" as const } : {}),
        });
        yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 2 * 60 * 60_000);
        yield* service.upsert(daily);
        // The server was off at 09:00: the stored due time is two hours old.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DateTime.formatIso(DateTime.toUtc(dueAt))} WHERE task_id = 'task:daily'`;
        // An interval task due in the same pass, after the daily one, tells us the pass is over.
        yield* service.upsert(input("task:sentinel"));
        yield* TestClock.adjust("6 seconds");
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.await(posted);
        const rows = (yield* service.list()).tasks;
        const row = rows.find((task) => task.id === "task:daily")!;
        const tomorrow = DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { days: 1 })));
        assert.equal(row.nextRunAt, tomorrow);
        if (policy === "once") {
          assert.deepEqual([row.runCount, row.lastRunStatus], [1, "succeeded"]);
          assert.include(posts, "task:daily");
        } else {
          assert.deepEqual([row.runCount, row.lastRunStatus], [0, "never"]);
          assert.notInclude(posts, "task:daily");
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
