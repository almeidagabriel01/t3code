import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AssistantId,
  type AssistantError,
  type AssistantsCreateInput,
  DEFAULT_ASSISTANT_ID,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as AssistantAvatars from "./AssistantAvatars.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AssistantConnectors from "./AssistantConnectors.ts";
import * as AssistantDirectory from "./AssistantDirectory.ts";
import * as AssistantTaskLinks from "./AssistantTasks.ts";
import * as Assistants from "./AssistantService.ts";

const scratch = ProjectId.make("scratch");
const repo = ProjectId.make("repo");
const missingProject = ProjectId.make("missing");
const model = (name: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: name,
});

interface FakeThread {
  projectId: string;
  deletedAt: string | null;
  archivedAt: string | null;
  modelSelection: ModelSelection;
  activeRunId?: string | null;
  shell?: Record<string, unknown>;
}

/** The thread side of the world, with the pointer each archive or delete saw recorded. */
const harness = () => {
  const threads = new Map<string, FakeThread>();
  const launched: Array<{ threadId: string; projectId: string; runtimeMode: string }> = [];
  const dispatched: Array<{ type: string; threadId: string; extra?: unknown }> = [];
  const retargets: Array<{ from: ReadonlyArray<string>; to: string; projectId: string }> = [];
  const taskDeletes: string[] = [];
  const tasks: Array<{ threadId: string | null; prompt: string; [key: string]: unknown }> = [];
  const failingTaskDeletes = new Set<string>();
  const pointers: Array<{ type: string; threadId: string; pointer: string | null; rows: number }> =
    [];

  const mocks = Layer.mergeAll(
    Layer.effect(
      ThreadManagement.ThreadManagementService,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          getThreadRecords: (threadId: string) => {
            const thread = threads.get(threadId);
            return thread === undefined
              ? Effect.fail(new Error("missing") as never)
              : Effect.succeed({ thread } as never);
          },
          getThreadShell: (threadId: string) =>
            Effect.succeed(
              (threads.has(threadId) || threadId.startsWith("assistant:")
                ? {
                    pendingRuntimeRequest: null,
                    pendingGuestMessageCount: 0,
                    pendingBackgroundTasks: [],
                    status: "completed",
                    activityRunStatus: null,
                    ...threads.get(threadId)?.shell,
                    activeRunId: threads.get(threadId)?.activeRunId ?? null,
                  }
                : null) as never,
            ),
          dispatch: (command: { type: string; threadId: string }) =>
            Effect.gen(function* () {
              const row = yield* sql<{
                thread_id: string | null;
              }>`SELECT thread_id FROM assistants WHERE thread_id = ${command.threadId}`;
              const all = yield* sql<{ n: number }>`SELECT count(*) AS n FROM assistants`;
              dispatched.push(command);
              pointers.push({
                type: command.type,
                threadId: command.threadId,
                pointer: row[0]?.thread_id ?? null,
                rows: all[0]!.n,
              });
              const thread = threads.get(command.threadId);
              if (thread !== undefined) {
                if (command.type === "thread.archive") thread.archivedAt = "now";
                if (command.type === "thread.unarchive") thread.archivedAt = null;
                if (command.type === "thread.delete") thread.deletedAt = "now";
              }
              return {} as never;
            }).pipe(Effect.orDie),
        } as never;
      }),
    ),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        const threadId = input.threadId!;
        if (!threads.has(threadId)) {
          threads.set(threadId, {
            projectId: input.projectId,
            deletedAt: null,
            archivedAt: null,
            modelSelection: input.modelSelection,
          });
          launched.push({
            threadId,
            projectId: input.projectId,
            runtimeMode: input.runtimeMode,
          });
        }
        return Effect.succeed({ threadId } as never);
      },
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      ensureAssistantProject: Effect.succeed({ projectId: scratch }),
      isAssistantHomeProject: (projectId) => Effect.succeed(projectId === scratch),
      namedProjectsRoot: "",
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      retargetThreadTasks: (input) => {
        retargets.push({
          from: input.fromThreadIds,
          to: input.toThreadId,
          projectId: input.projectId,
        });
        return Effect.void;
      },
      list: () => Effect.succeed({ tasks } as never),
      upsert: (input) => {
        tasks.push(input as never);
        return Effect.succeed({} as never);
      },
      deleteForThread: (threadId) => {
        taskDeletes.push(threadId);
        return failingTaskDeletes.has(threadId) ? Effect.fail("boom" as never) : Effect.void;
      },
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(projectId === missingProject ? Option.none() : Option.some({} as never)),
    }),
  );
  const base = Layer.mergeAll(
    NodeCrypto.layer,
    NodeServices.layer,
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "assistants-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    ServerSettings.layerTest(),
    SqlitePersistence.layerMemory,
  );
  const secretValues = new Map<string, Uint8Array>();
  const secretStore = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.succeed(Option.fromNullishOr(secretValues.get(name))),
      set: (name, value) => Effect.sync(() => void secretValues.set(name, value)),
      create: (name, value) => Effect.sync(() => void secretValues.set(name, value)),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: (name) => Effect.sync(() => void secretValues.delete(name)),
    }),
  );
  const connectorsLayer = AssistantConnectors.layer.pipe(
    Layer.provide(Layer.merge(secretStore, AssistantDirectory.layer)),
  );
  const layer = Assistants.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(mocks, connectorsLayer, AssistantTaskLinks.layer).pipe(
        Layer.provideMerge(base),
      ),
    ),
  );
  return {
    secretValues,
    layer,
    threads,
    launched,
    dispatched,
    pointers,
    retargets,
    taskDeletes,
    failingTaskDeletes,
    tasks,
  };
};

const create = (overrides: Partial<AssistantsCreateInput> = {}): AssistantsCreateInput => ({
  name: "Research Buddy",
  projectId: repo,
  instructions: "Be brief.",
  toolAccess: "workspace-write",
  ...overrides,
});

const jarvisThread = (n: number) => ThreadId.make(`assistant:${DEFAULT_ASSISTANT_ID}:${n}`);

it.effect("concurrent first calls make one Jarvis and one conversation", () => {
  const { layer, launched } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const results = yield* Effect.all(
      [assistants.ensureDefault, assistants.ensureDefault, assistants.list.pipe(Effect.asVoid)],
      { concurrency: "unbounded" },
    );
    assert.equal((results[0] as { id: string }).id, DEFAULT_ASSISTANT_ID);
    const all = yield* assistants.list;
    assert.deepEqual(
      all.map((assistant) => [assistant.id, assistant.threadId, assistant.toolAccess]),
      [[DEFAULT_ASSISTANT_ID as string, jarvisThread(1) as string | null, "full"]],
    );
    assert.equal(all[0]!.isDefault, true);
    assert.deepEqual(launched, [
      { threadId: jarvisThread(1), projectId: scratch, runtimeMode: "full-access" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("a deleted conversation is replaced by the next generation", () => {
  const { layer, threads, launched } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    yield* assistants.ensureDefault;
    threads.get(jarvisThread(1))!.deletedAt = "now";
    const jarvis = yield* assistants.ensureDefault;
    assert.equal(jarvis.threadId, jarvisThread(2));
    assert.equal(jarvis.generation, 2);
    assert.equal((yield* assistants.ensureDefault).threadId, jarvisThread(2));
    assert.lengthOf(launched, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("create derives a handle, keeps it reserved, and launches in the chosen project", () => {
  const { layer, launched } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const made = yield* assistants.create(create({ modelSelection: model("m1") }));
    assert.equal(made.handle, "research-buddy");
    assert.equal(made.threadId, `assistant:${made.id}:1`);
    assert.deepEqual(launched.at(-1), {
      threadId: made.threadId!,
      projectId: repo,
      runtimeMode: "auto-accept-edits",
    });

    const taken = yield* assistants.create(create()).pipe(Effect.flip);
    assert.equal(taken.reason, "handle_taken");
    // An archived assistant still holds its handle.
    yield* assistants.update({ assistantId: made.id, archived: true });
    assert.equal((yield* assistants.create(create()).pipe(Effect.flip)).reason, "handle_taken");

    assert.equal(
      (yield* assistants.create(create({ name: "!!!" })).pipe(Effect.flip)).reason,
      "invalid",
    );
    assert.equal(
      (yield* assistants
        .create(create({ name: "Other", projectId: missingProject }))
        .pipe(Effect.flip)).reason,
      "invalid",
    );
    // A refused create leaves no row behind.
    assert.lengthOf(yield* assistants.list, 2);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "reset moves the pointer before archiving the old conversation and keeps its model",
  () => {
    const { layer, threads, pointers, launched, retargets } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const made = yield* assistants.create(create({ modelSelection: model("m1") }));
      const reset = yield* assistants.reset({ assistantId: made.id });
      assert.equal(reset.threadId, `assistant:${made.id}:2`);
      assert.equal(threads.get(reset.threadId!)!.modelSelection.model, "m1");
      assert.deepEqual(pointers.at(-1), {
        type: "thread.archive",
        threadId: `assistant:${made.id}:1`,
        pointer: null,
        rows: 1,
      });
      assert.lengthOf(launched, 2);
      assert.deepEqual(retargets, [
        { from: [`assistant:${made.id}:1`], to: `assistant:${made.id}:2`, projectId: repo },
      ]);
      // Every older generation is a source, so tasks a failed reset left behind still follow.
      yield* assistants.reset({ assistantId: made.id });
      assert.deepEqual(retargets.at(-1), {
        from: [`assistant:${made.id}:1`, `assistant:${made.id}:2`],
        to: `assistant:${made.id}:3`,
        projectId: repo,
      });

      yield* assistants.ensureDefault;
      const jarvis = yield* assistants.reset({ assistantId: DEFAULT_ASSISTANT_ID as never });
      assert.equal(jarvis.threadId, jarvisThread(2));
    }).pipe(Effect.provide(layer));
  },
);

it.effect("restore brings back this assistant's own conversation only", () => {
  const { layer, pointers, retargets } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const made = yield* assistants.create(create());
    const first = made.threadId!;
    yield* assistants.reset({ assistantId: made.id });
    const other = yield* assistants.create(create({ name: "Other" }));

    for (const restoreThreadId of [other.threadId!, ThreadId.make("plain-thread")]) {
      const refused = yield* assistants
        .reset({ assistantId: made.id, restoreThreadId })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "invalid");
    }
    const gone = yield* assistants
      .reset({ assistantId: made.id, restoreThreadId: ThreadId.make(`assistant:${made.id}:9`) })
      .pipe(Effect.flip);
    assert.equal(gone.reason, "not_found");

    pointers.length = 0;
    retargets.length = 0;
    const restored = yield* assistants.reset({ assistantId: made.id, restoreThreadId: first });
    assert.deepEqual(retargets, [{ from: [`assistant:${made.id}:2`], to: first, projectId: repo }]);
    assert.equal(restored.threadId, first);
    // The old thread is already current when it is unarchived; the replaced one is archived after.
    assert.deepEqual(
      pointers.map((entry) => [entry.type, entry.threadId, entry.pointer]),
      [
        ["thread.unarchive", first, first],
        ["thread.archive", `assistant:${made.id}:2`, null],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("remove clears the assistant's transfers and requests, not the rest of shared/", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { sharedDir } = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const made = yield* assistants.create(create());
    const mine = path.join(sharedDir, "transfers", made.id, "message_1");
    const theirs = path.join(sharedDir, "transfers", "someone-else", "message_2");
    const loose = path.join(sharedDir, "notes.txt");
    for (const file of [path.join(mine, "a.txt"), path.join(theirs, "b.txt"), loose]) {
      yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
      yield* fileSystem.writeFileString(file, "x");
    }
    yield* sql`INSERT INTO assistant_requests (request_id, group_id, sender_thread_id, recipient_thread_id, status, created_at)
      VALUES ('r1', 'r1', ${`assistant:${made.id}:1`}, 'assistant:other:1', 'open', 'now'),
             ('r2', 'r2', 'assistant:other:1', ${`assistant:${made.id}:1`}, 'open', 'now')`;
    yield* assistants.remove(made.id);
    assert.isFalse(yield* fileSystem.exists(mine));
    assert.isTrue(yield* fileSystem.exists(path.join(theirs, "b.txt")));
    assert.isTrue(yield* fileSystem.exists(loose));
    assert.deepEqual(
      (yield* sql<{ request_id: string }>`SELECT request_id FROM assistant_requests`).map(
        (row) => row.request_id,
      ),
      ["r2"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("remove deletes the row first, then every conversation and its schedules", () => {
  const { layer, pointers, threads, taskDeletes } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const made = yield* assistants.create(create());
    yield* assistants.reset({ assistantId: made.id });
    pointers.length = 0;
    yield* assistants.remove(made.id);
    assert.deepEqual(
      pointers.map((entry) => [entry.type, entry.threadId, entry.rows]),
      [
        ["thread.delete", `assistant:${made.id}:1`, 0],
        ["thread.delete", `assistant:${made.id}:2`, 0],
      ],
    );
    assert.isTrue(threads.get(`assistant:${made.id}:2`)!.deletedAt !== null);
    assert.deepEqual(taskDeletes, [`assistant:${made.id}:1`, `assistant:${made.id}:2`]);
    assert.equal((yield* assistants.remove(made.id).pipe(Effect.flip)).reason, "not_found");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a schedule cleanup that fails does not keep the other conversations from deleting",
  () => {
    const { layer, taskDeletes, failingTaskDeletes } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const made = yield* assistants.create(create());
      yield* assistants.reset({ assistantId: made.id });
      failingTaskDeletes.add(`assistant:${made.id}:1`);
      yield* assistants.remove(made.id);
      assert.deepEqual(taskDeletes, [`assistant:${made.id}:1`, `assistant:${made.id}:2`]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "Jarvis can be archived or deleted, stays gone, and comes back only when restored",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const jarvis = (yield* assistants.list)[0]!;
      const edited = yield* assistants.update({ assistantId: jarvis.id, instructions: "Mine." });
      assert.equal(edited.instructions, "Mine.");

      yield* assistants.update({ assistantId: jarvis.id, archived: true });
      assert.equal((yield* assistants.list)[0]!.archivedAt === null, false);
      const unarchived = yield* assistants.create(create({ restoreDefault: true }));
      assert.equal(unarchived.archivedAt, null);
      assert.equal(unarchived.instructions, "Mine.");

      yield* assistants.remove(jarvis.id);
      assert.deepEqual(yield* assistants.list, []);
      assert.deepEqual(yield* assistants.list, []);
      const restored = yield* assistants.create(create({ restoreDefault: true }));
      assert.equal(restored.id, DEFAULT_ASSISTANT_ID);
      assert.equal(restored.isDefault, true);
      assert.notEqual(restored.instructions, "Mine.");
      assert.equal(restored.threadId, jarvisThread(1));
      assert.equal((yield* assistants.list).length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("an install that already had Jarvis keeps him archived and never reseeds", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const sql = yield* SqlClient.SqlClient;
    yield* assistants.list;
    yield* assistants.update({ assistantId: DEFAULT_ASSISTANT_ID as never, archived: true });
    // An install from before seeds were recorded: the backfill is this same statement.
    yield* sql`DELETE FROM assistant_seeds`;
    yield* sql`
      INSERT OR IGNORE INTO assistant_seeds (assistant_id, seeded_at)
      SELECT assistant_id, created_at FROM assistants WHERE is_default = 1`;
    const all = yield* assistants.list;
    assert.deepEqual(
      all.map((assistant) => [assistant.id, assistant.archivedAt === null]),
      [[DEFAULT_ASSISTANT_ID, false]],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("update writes the row, then renames, switches access and archives the thread", () => {
  const { layer, dispatched, pointers } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const made = yield* assistants.create(create());
    const updated = yield* assistants.update({
      assistantId: made.id,
      name: "Renamed",
      toolAccess: "read-only",
      modelSelection: model("m2"),
    });
    assert.equal(updated.toolAccess, "read-only");
    assert.deepEqual(
      dispatched.map((command) => command.type),
      [
        "thread.metadata.update",
        "thread.notice.record",
        "thread.model-selection.set",
        "thread.runtime-mode.set",
      ],
    );
    assert.equal((dispatched[1] as unknown as { message: string }).message, "Renamed to Renamed");
    assert.equal(
      (dispatched[3] as unknown as { runtimeMode: string }).runtimeMode,
      "approval-required",
    );

    pointers.length = 0;
    yield* assistants.update({ assistantId: made.id, archived: true });
    // The thread is archived while it is still the row's pointer, which the row now calls archived.
    assert.deepEqual(
      pointers.map((entry) => [entry.type, entry.pointer]),
      [["thread.archive", made.threadId]],
    );
    const back = yield* assistants.update({ assistantId: made.id, archived: false });
    assert.equal(back.archivedAt, null);
    assert.equal(dispatched.at(-1)!.type, "thread.unarchive");
  }).pipe(Effect.provide(layer));
});

it.effect("a project change starts a new generation there and retires the old thread", () => {
  const { layer, launched, pointers, retargets } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    yield* assistants.ensureDefault;
    const made = yield* assistants.create(create({ modelSelection: model("m1") }));
    pointers.length = 0;
    const moved = yield* assistants.update({ assistantId: made.id, projectId: scratch });
    assert.equal(moved.projectId, scratch);
    assert.equal(moved.generation, 2);
    assert.equal(moved.threadId, `assistant:${made.id}:2`);
    assert.deepEqual(launched.at(-1), {
      threadId: moved.threadId!,
      projectId: scratch,
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(
      pointers.map((entry) => [entry.type, entry.threadId, entry.pointer]),
      [["thread.archive", made.threadId, null]],
    );
    assert.deepEqual(retargets, [
      { from: [made.threadId!], to: moved.threadId!, projectId: scratch },
    ]);
    assert.equal(
      (yield* assistants.update({ assistantId: made.id, handle: "jarvis" }).pipe(Effect.flip))
        .reason,
      "handle_taken",
    );
    // Restoring a conversation from the old project brings the assistant back there with it.
    const restored = yield* assistants.reset({
      assistantId: made.id,
      restoreThreadId: made.threadId!,
    });
    assert.equal(restored.threadId, made.threadId);
    assert.equal(restored.projectId, made.projectId);
  }).pipe(Effect.provide(layer));
});

it.effect("a budget round-trips through create and update, and null removes it", () => {
  const { layer } = harness();
  const budget = {
    amountUsd: 5,
    period: "monthly",
    warnAtPercent: 80,
    blockWhenExceeded: true,
    timeZone: "UTC",
  } as const;
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const made = yield* assistants.create(create({ budget }));
    assert.deepEqual(made.budget, budget);
    assert.isNull((yield* assistants.create(create({ name: "Plain" }))).budget);
    const raised = yield* assistants.update({
      assistantId: made.id,
      budget: { ...budget, amountUsd: 9 },
    });
    assert.equal(raised.budget?.amountUsd, 9);
    // Other edits leave the cap alone; null takes it off.
    assert.equal(
      (yield* assistants.update({ assistantId: made.id, name: "Renamed" })).budget?.amountUsd,
      9,
    );
    assert.isNull((yield* assistants.update({ assistantId: made.id, budget: null })).budget);
    assert.isNull((yield* assistants.list).find((entry) => entry.id === made.id)!.budget);
  }).pipe(Effect.provide(layer));
});

it.effect("subscribers get a snapshot, then every change", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const received = yield* Queue.unbounded<string>();
    yield* assistants.subscribe.pipe(
      Stream.take(3),
      Stream.runForEach((event) =>
        Queue.offer(
          received,
          event.type === "snapshot"
            ? `snapshot:${event.assistants.map((assistant) => assistant.id).join(",")}`
            : event.type === "upserted"
              ? `upserted:${event.assistant.handle}`
              : event.type === "removed"
                ? `removed:${event.assistantId}`
                : event.type,
        ),
      ),
      Effect.forkScoped,
    );
    assert.equal(yield* Queue.take(received), `snapshot:${DEFAULT_ASSISTANT_ID}`);
    const made = yield* assistants.create(create());
    yield* assistants.remove(made.id);
    assert.equal(yield* Queue.take(received), "upserted:research-buddy");
    assert.equal(yield* Queue.take(received), `removed:${made.id}`);
  }).pipe(Effect.provide(layer));
});

const usableModel = (slug: string, extra: Partial<ServerProviderModel> = {}) =>
  ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
    ...extra,
  }) satisfies ServerProviderModel;
const usableProvider = (
  instanceId: string,
  extra: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "0.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-30T00:00:00.000Z",
  models: [usableModel(`${instanceId}-a`), usableModel(`${instanceId}-b`, { isDefault: true })],
  slashCommands: [],
  skills: [],
  ...extra,
});

it.each([
  ["no providers", [], null],
  [
    "first usable provider's default model",
    [usableProvider("claude"), usableProvider("codex")],
    "claude:claude-b",
  ],
  [
    "skips disabled",
    [usableProvider("claude", { enabled: false }), usableProvider("codex")],
    "codex:codex-b",
  ],
  [
    "skips not installed",
    [usableProvider("claude", { installed: false }), usableProvider("codex")],
    "codex:codex-b",
  ],
  [
    "skips signed out",
    [usableProvider("claude", { auth: { status: "unauthenticated" } }), usableProvider("codex")],
    "codex:codex-b",
  ],
  [
    "skips unavailable",
    [usableProvider("claude", { availability: "unavailable" }), usableProvider("codex")],
    "codex:codex-b",
  ],
  [
    "custom default falls back to a built-in model",
    [
      usableProvider("claude", {
        models: [usableModel("mine", { isCustom: true, isDefault: true }), usableModel("built-in")],
      }),
    ],
    "claude:built-in",
  ],
] as const)("firstUsableProviderModel: %s", (_name, providers, expected) => {
  const selection = Assistants.firstUsableProviderModel(providers);
  assert.strictEqual(
    selection === null ? null : `${selection.instanceId}:${selection.model}`,
    expected,
  );
});

it.effect(
  "icon defaults to none, is set on create, survives other updates and can be cleared",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const plain = yield* assistants.create(create({ name: "Plain" }));
      assert.isNull(plain.icon);
      const iconic = yield* assistants.create(create({ name: "Iconic", icon: "scout" }));
      assert.strictEqual(iconic.icon, "scout");
      assert.strictEqual(
        (yield* assistants.update({ assistantId: iconic.id, role: "QA" })).icon,
        "scout",
      );
      assert.strictEqual(
        (yield* assistants.update({ assistantId: iconic.id, icon: "spark" })).icon,
        "spark",
      );
      assert.isNull((yield* assistants.update({ assistantId: iconic.id, icon: null })).icon);
    }).pipe(Effect.provide(layer), Effect.orDie);
  },
);

it.effect(
  "connector secrets are write-only: reads show keys, omitted keeps, empty clears, deletes clean up",
  () => {
    const { layer, secretValues } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const connectors = yield* AssistantConnectors.AssistantConnectors;
      const docs = (headers: Array<{ key: string; value?: string }>, enabled = true) => ({
        name: "docs",
        transport: "http" as const,
        url: "https://docs.example.test/mcp",
        headers,
        enabled,
      });
      const made = yield* assistants.create(
        create({
          name: "Linked",
          mcpServers: [
            docs([{ key: "Authorization", value: "Bearer s3cret" }, { key: "X-Empty" }]),
            {
              name: "files",
              transport: "stdio",
              command: "npx",
              args: ["srv"],
              env: [{ key: "TOKEN", value: "tok" }],
              enabled: false,
            },
          ],
        }),
      );
      assert.deepEqual(
        made.mcpServers.map((server) => [server.name, server.enabled]),
        [
          ["docs", true],
          ["files", false],
        ],
      );
      assert.deepEqual(made.mcpServers[0]!.headers, [
        { key: "Authorization", hasValue: true },
        { key: "X-Empty", hasValue: false },
      ]);
      assert.notInclude(JSON.stringify(yield* assistants.list), "s3cret");
      assert.equal(secretValues.size, 2);

      const thread = made.threadId!;
      // Only enabled connectors reach the session, with values resolved.
      assert.deepEqual(yield* connectors.forThread(thread), [
        {
          name: "docs",
          transport: "http",
          url: "https://docs.example.test/mcp",
          args: [],
          headers: { Authorization: "Bearer s3cret" },
          env: {},
        },
      ]);
      assert.deepEqual(yield* connectors.forThread(ThreadId.make("plain-thread")), []);

      // An update that leaves the value out keeps it; an unrelated update leaves the list alone.
      yield* assistants.update({ assistantId: made.id, role: "QA" });
      const kept = yield* assistants.update({
        assistantId: made.id,
        mcpServers: [docs([{ key: "Authorization" }])],
      });
      assert.deepEqual(
        kept.mcpServers.map((server) => server.name),
        ["docs"],
      );
      assert.equal(secretValues.size, 1);
      assert.deepEqual((yield* connectors.forThread(thread))[0]!.headers, {
        Authorization: "Bearer s3cret",
      });

      // An explicit empty value clears it.
      const cleared = yield* assistants.update({
        assistantId: made.id,
        mcpServers: [docs([{ key: "Authorization", value: "" }])],
      });
      assert.deepEqual(cleared.mcpServers[0]!.headers, [{ key: "Authorization", hasValue: false }]);
      assert.equal(secretValues.size, 0);

      // Unusable lists are refused before any write.
      const bad = yield* Effect.flip(
        assistants.update({
          assistantId: made.id,
          mcpServers: [docs([{ key: "A", value: "v" }]), docs([])],
        }),
      );
      assert.equal(bad.reason, "invalid");
      assert.equal(secretValues.size, 0);

      yield* assistants.update({
        assistantId: made.id,
        mcpServers: [docs([{ key: "Authorization", value: "again" }])],
      });
      assert.equal(secretValues.size, 1);
      yield* assistants.remove(made.id);
      assert.equal(secretValues.size, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("ask before acting defaults off, is set on create and survives other updates", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const plain = yield* assistants.create(create({ name: "Plain" }));
    assert.isFalse(plain.askBeforeActing);
    const asker = yield* assistants.create(create({ name: "Asker", askBeforeActing: true }));
    assert.isTrue(asker.askBeforeActing);
    assert.isTrue(
      (yield* assistants.update({ assistantId: asker.id, role: "QA" })).askBeforeActing,
    );
    assert.isFalse(
      (yield* assistants.update({ assistantId: asker.id, askBeforeActing: false })).askBeforeActing,
    );
    assert.isTrue(
      (yield* assistants.update({ assistantId: plain.id, askBeforeActing: true })).askBeforeActing,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("workspace defaults to host, is set on create and survives other updates", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const plain = yield* assistants.create(create({ name: "Plain" }));
    assert.strictEqual(plain.workspace, "host");
    const boxed = yield* assistants.create(create({ name: "Boxed", workspace: "sandbox" }));
    assert.strictEqual(boxed.workspace, "sandbox");
    assert.strictEqual(
      (yield* assistants.update({ assistantId: boxed.id, role: "QA" })).workspace,
      "sandbox",
    );
    assert.strictEqual(
      (yield* assistants.update({ assistantId: boxed.id, workspace: "host" })).workspace,
      "host",
    );
    assert.strictEqual(
      (yield* assistants.update({ assistantId: plain.id, workspace: "sandbox" })).workspace,
      "sandbox",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("role is trimmed on create and update", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const ceo = yield* assistants.create(create({ name: "Ceo", role: "  CEO  " }));
    assert.equal(ceo.role, "CEO");
    assert.equal(
      (yield* assistants.update({ assistantId: ceo.id, role: " Founder " })).role,
      "Founder",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("teams: validation, lead rules and deletion cleanup", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const make = (name: string) => assistants.create(create({ name }));
    const [ana, bob, cy, dee] = [
      yield* make("Ana"),
      yield* make("Bob"),
      yield* make("Cy"),
      yield* make("Dee"),
    ];
    const refused = <A>(effect: Effect.Effect<A, AssistantError>) =>
      effect.pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

    // A group can start empty or with one member; it still needs a name and real members.
    const empty = yield* assistants.createTeam({ name: "Empty", memberIds: [] });
    const solo = yield* assistants.createTeam({ name: "Solo", memberIds: [ana.id] });
    assert.deepEqual([empty.memberIds, solo.memberIds], [[], [ana.id]]);
    yield* assistants.removeTeam(empty.id);
    yield* assistants.removeTeam(solo.id);
    assert.include(
      yield* refused(
        assistants.createTeam({ name: "T", memberIds: [ana.id, bob.id], leadId: cy.id }),
      ),
      "member",
    );
    assert.include(
      yield* refused(assistants.createTeam({ name: "T", memberIds: [ana.id, "ghost" as never] })),
      "does not exist",
    );

    const team = yield* assistants.createTeam({
      name: "Growth",
      memberIds: [ana.id, bob.id, cy.id],
      leadId: ana.id,
    });
    assert.equal(team.leadId, ana.id);
    assert.deepEqual(yield* assistants.teams, [team]);
    const [snapshot] = yield* assistants.subscribe.pipe(Stream.take(1), Stream.runCollect);
    assert.deepEqual(snapshot?.type === "snapshot" ? snapshot.teams : [], [team]);

    const headless = yield* assistants.updateTeam({ teamId: team.id, leadId: null });
    assert.isNull(headless.leadId);
    const led = yield* assistants.updateTeam({ teamId: team.id, leadId: bob.id, name: "Money" });
    assert.deepEqual([led.name, led.leadId], ["Money", bob.id]);
    assert.deepEqual([team.instructions, team.memories], ["", []]);
    const briefed = yield* assistants.updateTeam({
      teamId: team.id,
      instructions: "  Answer in Portuguese.  ",
      memories: ["Budget is 5k"],
    });
    assert.deepEqual(
      [briefed.instructions, briefed.memories],
      ["Answer in Portuguese.", ["Budget is 5k"]],
    );
    // A field left out is kept.
    const renamed = yield* assistants.updateTeam({ teamId: team.id, name: "Money 2" });
    assert.deepEqual(
      [renamed.instructions, renamed.memories],
      ["Answer in Portuguese.", ["Budget is 5k"]],
    );
    yield* assistants.updateTeam({
      teamId: team.id,
      name: "Money",
      instructions: "",
      memories: [],
    });
    // A lead that is not a member is refused; one dropped from the members is cleared.
    assert.include(
      yield* refused(assistants.updateTeam({ teamId: team.id, leadId: dee.id })),
      "member",
    );
    const dropped = yield* assistants.updateTeam({ teamId: team.id, memberIds: [ana.id, cy.id] });
    assert.deepEqual([dropped.memberIds, dropped.leadId], [[ana.id, cy.id], null]);
    yield* assistants.updateTeam({
      teamId: team.id,
      leadId: bob.id,
      memberIds: [ana.id, bob.id, cy.id],
    });
    assert.equal(
      (yield* assistants.updateTeam({
        teamId: team.id,
        memberIds: [ana.id, bob.id, cy.id, dee.id],
      })).memberIds.length,
      4,
    );
    yield* assistants.update({ assistantId: dee.id, archived: true });
    assert.include(
      yield* refused(
        assistants
          .updateTeam({ teamId: team.id, memberIds: [ana.id, bob.id, cy.id] })
          .pipe(
            Effect.andThen(assistants.createTeam({ name: "Late", memberIds: [ana.id, dee.id] })),
          ),
      ),
      "archived",
    );
    assert.equal(
      yield* refused(assistants.updateTeam({ teamId: "nope" as never })),
      "Team not found.",
    );

    // Deleting a member removes it; the lead slot empties; the group stays even when one is left.
    yield* assistants.update({ assistantId: dee.id, archived: false });
    yield* assistants.remove(bob.id);
    const left = (yield* assistants.teams)[0]!;
    assert.deepEqual([left.memberIds, left.leadId], [[ana.id, cy.id], null]);
    yield* assistants.remove(cy.id);
    assert.deepEqual(
      (yield* assistants.teams).map((kept) => kept.memberIds),
      [[ana.id]],
    );
    yield* assistants.remove(ana.id);
    assert.deepEqual(
      (yield* assistants.teams).map((kept) => kept.memberIds),
      [[]],
    );
    yield* assistants.removeTeam(team.id);
    assert.equal((yield* assistants.removeTeam(team.id).pipe(Effect.flip)).reason, "not_found");
    const another = yield* assistants.createTeam({
      name: "Two",
      memberIds: [dee.id, (yield* make("Eve")).id],
    });
    yield* assistants.removeTeam(another.id);
    assert.deepEqual(yield* assistants.teams, []);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "archiving a group keeps its members, restoring clears it, and changes are published",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const subscription = yield* assistants.subscribeChanges;
      const ana = yield* assistants.create(create({ name: "Ana" }));
      const team = yield* assistants.createTeam({ name: "Core", memberIds: [ana.id] });
      assert.isNull(team.archivedAt);
      const archived = yield* assistants.updateTeam({ teamId: team.id, archived: true });
      assert.isString(archived.archivedAt);
      assert.deepEqual(archived.memberIds, [ana.id]);
      // Archiving again keeps the first time; other edits leave it alone.
      const again = yield* assistants.updateTeam({
        teamId: team.id,
        archived: true,
        name: "Core 2",
      });
      assert.equal(again.archivedAt, archived.archivedAt);
      assert.equal(
        (yield* assistants.updateTeam({ teamId: team.id, name: "Core 3" })).archivedAt,
        archived.archivedAt,
      );
      assert.isNull(
        (yield* assistants.updateTeam({ teamId: team.id, archived: false })).archivedAt,
      );
      const seen = yield* PubSub.takeAll(subscription);
      assert.deepEqual(
        seen
          .filter((event) => event.type === "teamUpserted")
          .map((event) => event.team.archivedAt === null),
        [true, false, false, false, true],
      );
      assert.isNumber((yield* assistants.defaultModel(repo)).model.length);
    }).pipe(Effect.provide(layer), Effect.scoped);
  },
);

it.effect(
  "scope follows the project: home projects are for everyone, a real project is its own",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const everywhere = yield* assistants.create(create({ name: "Home", projectId: scratch }));
      const scoped = yield* assistants.create(create({ name: "Repo" }));
      assert.deepEqual([everywhere.scope, scoped.scope], ["all", "project"]);
      // scope "all" needs no home project from the caller.
      const asked = yield* assistants.create(create({ name: "Asked", scope: "all" }));
      assert.deepEqual([asked.scope, asked.projectId], ["all", scratch]);
      assert.equal(
        (yield* assistants.update({ assistantId: scoped.id, scope: "all" })).projectId,
        scratch,
      );
      yield* assistants.update({ assistantId: scoped.id, projectId: repo });
      assert.equal(
        (yield* assistants.update({ assistantId: scoped.id, projectId: scratch })).scope,
        "all",
      );
      assert.equal(
        (yield* assistants.update({ assistantId: scoped.id, projectId: repo })).scope,
        "project",
      );
      // A row from before scopes existed is worked out on the next read.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE assistants SET scope = NULL WHERE assistant_id = ${scoped.id}`;
      const listed = yield* assistants.list;
      assert.equal(listed.find((one) => one.id === scoped.id)?.scope, "project");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a group keeps its own projects, replaced or changed by delta, and only real ones",
  () => {
    const { layer } = harness();
    const docs = ProjectId.make("docs");
    const web = ProjectId.make("web");
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const refused = <A>(effect: Effect.Effect<A, AssistantError>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      const ana = yield* assistants.create(create({ name: "Ana", projectIds: [repo] }));
      const team = yield* assistants.createTeam({ name: "Dev", memberIds: [ana.id] });
      assert.deepEqual(team.projectIds, []);
      const set = yield* assistants.updateTeam({ teamId: team.id, projectIds: [docs, repo, docs] });
      assert.deepEqual(set.projectIds, [docs, repo]);
      // Removals apply last, so an id in both lists ends up out.
      const changed = yield* assistants.updateTeam({
        teamId: team.id,
        addProjectIds: [web, repo],
        removeProjectIds: [repo, web],
      });
      assert.deepEqual(changed.projectIds, [docs]);
      for (const bad of [missingProject, scratch]) {
        assert.include(
          yield* refused(assistants.updateTeam({ teamId: team.id, addProjectIds: [web, bad] })),
          "does not exist",
        );
      }
      assert.deepEqual((yield* assistants.teams)[0]?.projectIds, [docs]);
      // Other fields leave the list alone, and a member's own list never changes with it.
      const renamed = yield* assistants.updateTeam({ teamId: team.id, name: "Dev 2" });
      assert.deepEqual(renamed.projectIds, [docs]);
      assert.deepEqual((yield* assistants.list).find((one) => one.id === ana.id)?.projectIds, [
        repo,
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a project assistant keeps a list of projects, and only a new home starts a conversation",
  () => {
    const { layer } = harness();
    const docs = ProjectId.make("docs");
    const web = ProjectId.make("web");
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const made = yield* assistants.create(create({ projectIds: [repo, docs, repo] }));
      assert.deepEqual(
        [made.projectId, made.projectIds, made.scope],
        [repo, [repo, docs], "project"],
      );
      const added = yield* assistants.update({
        assistantId: made.id,
        projectIds: [docs, repo, web],
      });
      assert.deepEqual(
        [added.projectId, added.projectIds, added.generation],
        [repo, [docs, repo, web], 1],
      );
      const moved = yield* assistants.update({ assistantId: made.id, projectIds: [docs, web] });
      assert.deepEqual(
        [moved.projectId, moved.projectIds, moved.generation],
        [docs, [docs, web], 2],
      );
      const single = yield* assistants.update({ assistantId: made.id, projectId: web });
      assert.deepEqual([single.projectId, single.projectIds], [web, [web]]);
      const everywhere = yield* assistants.update({
        assistantId: made.id,
        projectIds: [web, scratch],
      });
      assert.deepEqual([everywhere.scope, everywhere.projectIds], ["all", []]);
      // A row saved before lists existed reads as a list of its one project.
      const sql = yield* SqlClient.SqlClient;
      const old = yield* assistants.create(create({ name: "Old" }));
      yield* sql`UPDATE assistants SET project_ids_json = NULL WHERE assistant_id = ${old.id}`;
      assert.deepEqual((yield* assistants.list).find((one) => one.id === old.id)?.projectIds, [
        repo,
      ]);
      yield* sql`UPDATE assistants SET project_ids_json = 'not json' WHERE assistant_id = ${old.id}`;
      assert.deepEqual((yield* assistants.list).find((one) => one.id === old.id)?.projectIds, [
        repo,
      ]);
      // A saved list is read as it is stored.
      yield* sql`UPDATE assistants SET project_ids_json = '["web","docs"]', project_id = 'web' WHERE assistant_id = ${old.id}`;
      assert.deepEqual((yield* assistants.list).find((one) => one.id === old.id)?.projectIds, [
        web,
        docs,
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "create with an id is idempotent; without avatar or icon an old row still decodes",
  () => {
    const { layer, launched } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const first = yield* assistants.create(create(), { id: "mcp-fixed" });
      const again = yield* assistants.create(create(), { id: "mcp-fixed" });
      assert.deepEqual([first.id, again.id], ["mcp-fixed", "mcp-fixed"]);
      assert.lengthOf(launched, 1);
      assert.deepEqual([first.avatar, first.icon], [null, null]);
      const team = yield* assistants.createTeam({ name: "G", memberIds: [] }, { id: "team-fixed" });
      const teamAgain = yield* assistants.createTeam(
        { name: "G", memberIds: [] },
        { id: "team-fixed" },
      );
      assert.equal(team.id, teamAgain.id);
      assert.lengthOf(yield* assistants.teams, 1);
      // An avatar written by a newer version decodes to none instead of hiding the assistant.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE assistants SET avatar_json = '{"kind":"hologram"}' WHERE assistant_id = 'mcp-fixed'`;
      assert.isNull((yield* assistants.list).find((one) => one.id === "mcp-fixed")?.avatar);
    }).pipe(Effect.provide(layer));
  },
);

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

it.effect(
  "avatar: robot set and clear, image upload checked by bytes and size, then cleared",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const made = yield* assistants.create(
        create({ avatar: { kind: "robot", hue: 200, variant: 2 } }),
      );
      assert.deepEqual(made.avatar, { kind: "robot", hue: 200, variant: 2 });

      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      const upload = (bytes: Uint8Array) =>
        Effect.gen(function* () {
          const id = createPendingAttachmentId("png");
          yield* fileSystem.writeFile(path.join(config.attachmentsDir, `${id}.png`), bytes);
          return id;
        });
      const refused = (attachmentId: string) =>
        assistants.setAvatarImage({ assistantId: made.id, attachmentId }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );

      assert.include(
        yield* refused(yield* upload(new TextEncoder().encode("<svg/>"))),
        "PNG, JPEG or WebP",
      );
      assert.include(
        yield* refused(yield* upload(new Uint8Array(2 * 1024 * 1024 + 1).fill(1))),
        "larger",
      );
      assert.include(yield* refused("chat-thread-attachment"), "Upload the image first");
      assert.include(yield* refused("pending-00000000-0000-0000-0000-000000000000-png"), "gone");

      const set = yield* assistants.setAvatarImage({
        assistantId: made.id,
        attachmentId: yield* upload(PNG),
      });
      assert.equal(set.avatar?.kind, "image");
      const stored = yield* AssistantAvatars.findAvatarFile(made.id);
      assert.equal(stored?.mimeType, "image/png");
      assert.deepEqual(Array.from(yield* fileSystem.readFile(stored!.path)), Array.from(PNG));

      const cleared = yield* assistants.update({ assistantId: made.id, avatar: null });
      assert.isNull(cleared.avatar);
      assert.isNull(yield* AssistantAvatars.findAvatarFile(made.id));

      // Deleting the assistant removes a stored image too.
      yield* assistants.setAvatarImage({ assistantId: made.id, attachmentId: yield* upload(PNG) });
      yield* assistants.remove(made.id);
      assert.isNull(yield* AssistantAvatars.findAvatarFile(made.id));
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a chat counter refresh reaches the stream but not services reacting to changes", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* assistants.subscribeChanges;
    const ana = yield* assistants.create(create({ name: "Ana" }));
    const team = yield* assistants.createTeam({ name: "Core", memberIds: [ana.id] });
    assert.deepEqual(team.chat, {
      latestSeq: 0,
      readSeq: 0,
      unreadCount: 0,
      working: false,
      preview: null,
    });
    yield* sql`INSERT INTO assistant_group_messages
      (message_id, team_id, seq, author, kind, text, created_at)
      VALUES ('m1', ${team.id}, 1, 'assistant', 'message', 'Done', '2026-01-01')`;
    yield* PubSub.takeAll(changes);
    // The snapshot arrives after the stream subscribed, so the refresh lands behind it.
    const events = yield* assistants.subscribe.pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? assistants.refreshTeamChat(team.id) : Effect.void,
      ),
      Stream.take(2),
      Stream.runCollect,
    );
    const event = events[1];
    assert.deepEqual(
      event?.type === "teamUpserted"
        ? [event.team.chat?.unreadCount, event.team.chat?.preview]
        : [],
      [1, "Done"],
    );
    assert.isFalse((yield* PubSub.takeAll(changes)).some((seen) => seen.type === "teamUpserted"));
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect(
  "a task is dismissed and restored, both repeat-safe, and a running one is refused",
  () => {
    const { layer, threads } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const links = yield* AssistantTaskLinks.AssistantTasks;
      yield* links.link({
        threadId: ThreadId.make("task-1"),
        assistantId: AssistantId.make(DEFAULT_ASSISTANT_ID),
        projectId: repo,
        title: "Add retry",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      threads.set("task-1", {
        projectId: repo,
        deletedAt: null,
        archivedAt: null,
        modelSelection: model("m"),
        activeRunId: "run-1",
      });
      const task = ThreadId.make("task-1");

      const refused = yield* assistants.dismissTask(task).pipe(Effect.flip);
      assert.equal(refused.reason, "invalid");
      assert.isNull((yield* links.list)[0]?.dismissedAt);

      threads.get("task-1")!.activeRunId = null;
      const first = yield* assistants.dismissTask(task);
      assert.isString(first.dismissedAt);
      assert.equal((yield* assistants.dismissTask(task)).dismissedAt, first.dismissedAt);
      assert.equal((yield* links.list)[0]?.dismissedAt, first.dismissedAt);

      // Restoring needs no idle thread, and a repeat lands on the same result.
      threads.get("task-1")!.activeRunId = "run-2";
      assert.isNull((yield* assistants.restoreTask(task)).dismissedAt);
      assert.isNull((yield* assistants.restoreTask(task)).dismissedAt);

      const missing = yield* assistants.restoreTask(ThreadId.make("nope")).pipe(Effect.flip);
      assert.equal(missing.reason, "not_found");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "tasksOf gives each task the status its row shows, newest first, and skips gone threads",
  () => {
    const { layer, threads } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const links = yield* AssistantTaskLinks.AssistantTasks;
      const owner = AssistantId.make(DEFAULT_ASSISTANT_ID);
      const cases: ReadonlyArray<readonly [string, Record<string, unknown> | null, string]> = [
        ["t-done", { status: "completed" }, "done"],
        ["t-run", { status: "running", activityRunStatus: "running" }, "running"],
        ["t-ask", { status: "running", pendingRuntimeRequest: { kind: "user_input" } }, "waiting"],
        ["t-fail", { status: "failed" }, "failed"],
        ["t-gone", null, ""],
      ];
      for (const [index, [id, shell]] of cases.entries()) {
        yield* links.link({
          threadId: ThreadId.make(id),
          assistantId: owner,
          projectId: repo,
          title: id,
          createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        });
        if (shell !== null) {
          threads.set(id, {
            projectId: repo,
            deletedAt: null,
            archivedAt: null,
            modelSelection: model("m"),
            shell,
          });
        }
      }
      yield* assistants.dismissTask(ThreadId.make("t-done"));
      const { tasks, truncated } = yield* assistants.tasksOf(owner);
      assert.isFalse(truncated);
      assert.deepEqual(
        tasks.map((task) => [task.threadId, task.status, task.dismissed]),
        [
          ["t-fail", "failed", false],
          ["t-ask", "waiting", false],
          ["t-run", "running", false],
          ["t-done", "done", true],
        ],
      );
    }).pipe(Effect.provide(layer));
  },
);
