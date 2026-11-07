import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AssistantError,
  type AssistantsCreateInput,
  DEFAULT_ASSISTANT_ID,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ASSISTANT_STANDUP_PROMPT,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
          dispatch: (command: { type: string; threadId: string }) =>
            Effect.gen(function* () {
              const row = yield* sql<{
                thread_id: string | null;
              }>`SELECT thread_id FROM assistants WHERE thread_id = ${command.threadId}`.pipe(
                Effect.orDie,
              );
              const all = yield* sql<{ n: number }>`SELECT count(*) AS n FROM assistants`.pipe(
                Effect.orDie,
              );
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
            }),
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
    Layer.provideMerge(Layer.mergeAll(mocks, connectorsLayer).pipe(Layer.provideMerge(base))),
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
      ["thread.metadata.update", "thread.model-selection.set", "thread.runtime-mode.set"],
    );
    assert.equal(
      (dispatched[2] as unknown as { runtimeMode: string }).runtimeMode,
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

it.effect(
  "reports-to is validated, loops are refused, and a leader that leaves frees its reports",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const reason = <A>(effect: Effect.Effect<A, AssistantError>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => `${error.reason}: ${error.message}`),
        );
      const ceo = yield* assistants.create(create({ name: "Ceo", role: "  CEO  " }));
      assert.equal(ceo.role, "CEO");
      assert.isNull(ceo.reportsTo);
      const lead = yield* assistants.create(create({ name: "Lead", reportsTo: ceo.id }));
      const eng = yield* assistants.create(create({ name: "Eng", reportsTo: lead.id }));
      assert.equal(eng.reportsTo, lead.id);

      const refused = [
        yield* reason(assistants.update({ assistantId: ceo.id, reportsTo: ceo.id })),
        yield* reason(assistants.update({ assistantId: ceo.id, reportsTo: eng.id })),
        yield* reason(assistants.update({ assistantId: lead.id, reportsTo: eng.id })),
        yield* reason(assistants.update({ assistantId: eng.id, reportsTo: "ghost" as never })),
        yield* reason(assistants.create(create({ name: "Orphan", reportsTo: "ghost" as never }))),
      ];
      assert.deepEqual(
        refused.map((text) => text.split(":")[0]),
        ["invalid", "invalid", "invalid", "invalid", "invalid"],
      );
      assert.include(refused[0], "itself");
      assert.include(refused[1], "loop");

      // Archived leaders can't be chosen, and archiving one frees its reports.
      yield* assistants.update({ assistantId: lead.id, archived: true });
      assert.isNull((yield* assistants.list).find((entry) => entry.id === eng.id)!.reportsTo);
      assert.include(
        yield* reason(assistants.update({ assistantId: eng.id, reportsTo: lead.id })),
        "archived",
      );
      // Null makes it top-level again; deleting a leader frees its reports.
      yield* assistants.update({ assistantId: eng.id, reportsTo: ceo.id });
      assert.equal(
        (yield* assistants.update({ assistantId: eng.id, reportsTo: null })).reportsTo,
        null,
      );
      yield* assistants.update({ assistantId: eng.id, reportsTo: ceo.id, role: "Engineer" });
      yield* assistants.remove(ceo.id);
      const after = (yield* assistants.list).find((entry) => entry.id === eng.id)!;
      assert.isNull(after.reportsTo);
      assert.equal(after.role, "Engineer");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("addStandup creates one weekday 09:00 task bound to the leader, only for leaders", () => {
  const { layer, tasks } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const leader = yield* assistants.create(create({ name: "Boss", modelSelection: model("m1") }));
    const standup = (assistantId: string) =>
      assistants.update({ assistantId: assistantId as never, addStandup: true });
    assert.equal((yield* standup(leader.id).pipe(Effect.flip)).reason, "invalid");
    const archivedLeader = yield* assistants.create(create({ name: "Old boss" }));
    yield* assistants.update({ assistantId: archivedLeader.id, archived: true });
    assert.include(
      (yield* standup(archivedLeader.id).pipe(Effect.flip)).message,
      "Unarchive the assistant",
    );
    const report = yield* assistants.create(create({ name: "Worker", reportsTo: leader.id }));
    assert.equal((yield* standup(report.id).pipe(Effect.flip)).reason, "invalid");

    yield* standup(leader.id);
    yield* standup(leader.id);
    assert.lengthOf(tasks, 1);
    assert.deepInclude(tasks[0]!, {
      threadId: leader.threadId,
      prompt: ASSISTANT_STANDUP_PROMPT,
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      modelSelection: model("m1"),
    });
  }).pipe(Effect.provide(layer));
});

const sentEvent = (
  sequence: number,
  stream: string,
  sender: string,
  text: string,
  id = `m${sequence}`,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${sequence}, ${`event-${sequence}`}, 'thread', ${stream}, ${sequence}, 'message.updated',
        ${`2026-11-06T10:00:0${sequence % 10}.000Z`}, 'agent',
        ${JSON.stringify({ id, text, senderThreadId: sender })}, '{}', 2
      )`;
  });

const threadEvent = (sequence: number, stream: string, type: string, payload: object) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${sequence}, ${`event-${sequence}`}, 'thread', ${stream}, ${sequence}, ${type},
        ${`2026-11-06T11:00:${String(sequence % 60).padStart(2, "0")}.000Z`}, 'agent',
        ${JSON.stringify(payload)}, '{}', 2
      )`;
  });

it.effect("teams: activity carries the recipient's reply for the run each message started", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const assistants = yield* Assistants.AssistantService;
    const ana = yield* assistants.create(create({ name: "Ana" }));
    const bob = yield* assistants.create(create({ name: "Bob" }));
    const team = yield* assistants.createTeam({ name: "Duo", memberIds: [ana.id, bob.id] });
    const [from, to] = [`assistant:${ana.id}:1`, `assistant:${bob.id}:1`];
    const ask = (sequence: number, id: string, runId: string) =>
      threadEvent(sequence, to, "message.updated", {
        id,
        runId,
        role: "user",
        text: id,
        senderThreadId: from,
      });
    const run = (sequence: number, id: string, status: string) =>
      threadEvent(sequence, to, "run.updated", { id, status });
    const say = (sequence: number, id: string, runId: string, text: string) =>
      threadEvent(sequence, to, "message.updated", { id, runId, role: "assistant", text });
    const replies = () =>
      assistants
        .teamActivity(team.id)
        .pipe(Effect.map((a) => a.messages.map((m) => [m.reply?.text ?? null, m.waiting])));

    yield* ask(1, "q1", "r1");
    yield* run(2, "r1", "running");
    yield* say(3, "a1", "r1", "draft");
    assert.deepEqual(yield* replies(), [[null, true]]);

    yield* say(4, "a1", "r1", "final answer");
    yield* run(5, "r1", "completed");
    yield* ask(6, "q2", "r2");
    yield* run(7, "r2", "running");
    // A later unrelated message in the thread belongs to the newer run, not to q1.
    yield* say(8, "a2", "r2", "other run");
    yield* run(9, "r2", "completed");
    yield* run(10, "r3", "completed");
    assert.deepEqual(yield* replies(), [
      ["final answer", false],
      ["other run", false],
    ]);

    yield* ask(11, "q3", "r4");
    yield* run(12, "r4", "failed");
    assert.deepEqual((yield* replies()).at(-1), [null, false]);

    // Without a run link, the first assistant text before the next user message answers it.
    yield* threadEvent(13, to, "message.updated", {
      id: "q4",
      role: "user",
      text: "q4",
      senderThreadId: from,
    });
    yield* threadEvent(14, to, "message.updated", { id: "a4", role: "assistant", text: "linked" });
    yield* threadEvent(15, to, "message.updated", { id: "u5", role: "user", text: "next" });
    yield* threadEvent(16, to, "message.updated", { id: "a5", role: "assistant", text: "later" });
    assert.deepEqual((yield* replies()).at(-1), ["linked", false]);
  }).pipe(Effect.provide(layer));
});

it.effect("teams: validation, leader rules, deletion cleanup and member-to-member activity", () => {
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
        assistants.createTeam({ name: "T", memberIds: [ana.id, bob.id], leaderId: cy.id }),
      ),
      "member",
    );
    assert.include(
      yield* refused(
        assistants.createTeam({ name: "T", memberIds: [ana.id, bob.id], leaderTitle: "CEO" }),
      ),
      "needs a leader",
    );
    assert.include(
      yield* refused(assistants.createTeam({ name: "T", memberIds: [ana.id, "ghost" as never] })),
      "does not exist",
    );

    const team = yield* assistants.createTeam({
      name: "Growth",
      memberIds: [ana.id, bob.id, cy.id],
      leaderId: ana.id,
      leaderTitle: "  CEO ",
    });
    assert.equal(team.leaderTitle, "CEO");
    assert.deepEqual(yield* assistants.teams, [team]);
    const [snapshot] = yield* assistants.subscribe.pipe(Stream.take(1), Stream.runCollect);
    assert.deepEqual(snapshot?.type === "snapshot" ? snapshot.teams : [], [team]);

    // Dropping the leader drops its title; a blank title is no title.
    const headless = yield* assistants.updateTeam({ teamId: team.id, leaderId: null });
    assert.deepEqual([headless.leaderId, headless.leaderTitle], [null, null]);
    const titled = yield* assistants.updateTeam({
      teamId: team.id,
      leaderId: bob.id,
      leaderTitle: "CFO",
      name: "Money",
    });
    assert.deepEqual([titled.name, titled.leaderId, titled.leaderTitle], ["Money", bob.id, "CFO"]);
    assert.include(
      yield* refused(assistants.updateTeam({ teamId: team.id, memberIds: [ana.id, cy.id] })),
      "member",
    );
    assert.equal(
      (yield* assistants.updateTeam({ teamId: team.id, leaderTitle: "  " })).leaderTitle,
      null,
    );
    assert.equal(
      (yield* assistants.updateTeam({ teamId: team.id, leaderTitle: "Head" })).leaderTitle,
      "Head",
    );
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

    // Only messages from a member into another member's conversation count; streamed
    // re-publishes of one message collapse; an outsider and a plain thread are ignored.
    yield* sentEvent(1, `assistant:${bob.id}:1`, `assistant:${ana.id}:1`, "a to b", "x");
    yield* sentEvent(2, `assistant:${bob.id}:1`, `assistant:${ana.id}:1`, "a to b v2", "x");
    yield* sentEvent(3, `assistant:${ana.id}:1`, `assistant:${bob.id}:1`, "b to a");
    yield* sentEvent(4, `assistant:${cy.id}:1`, `assistant:${dee.id}:1`, "outsider to cy");
    yield* sentEvent(5, `assistant:${ana.id}:1`, "thread:plain", "from a plain thread");
    yield* sentEvent(6, "thread:plain", `assistant:${ana.id}:1`, "to a plain thread");
    const activity = yield* assistants.teamActivity(team.id);
    assert.deepEqual(
      activity.messages.map((message) => [
        message.text,
        message.fromAssistantId,
        message.toAssistantId,
      ]),
      [
        ["a to b v2", ana.id, bob.id],
        ["b to a", bob.id, ana.id],
      ],
    );
    assert.isFalse(activity.messages[0]!.truncated);
    yield* sentEvent(7, `assistant:${bob.id}:1`, `assistant:${ana.id}:1`, "x".repeat(5000));
    const long = (yield* assistants.teamActivity(team.id)).messages.at(-1)!;
    assert.deepEqual([long.text.length, long.truncated], [4000, true]);

    // Deleting a member removes it; the leader slot empties; the group stays even when one is left.
    yield* assistants.update({ assistantId: dee.id, archived: false });
    yield* assistants.remove(bob.id);
    const left = (yield* assistants.teams)[0]!;
    assert.deepEqual(
      [left.memberIds, left.leaderId, left.leaderTitle],
      [[ana.id, cy.id], null, null],
    );
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
  "scope follows the project: home projects are for everyone, a real project is its own",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const assistants = yield* Assistants.AssistantService;
      const everywhere = yield* assistants.create(create({ name: "Home", projectId: scratch }));
      const scoped = yield* assistants.create(create({ name: "Repo" }));
      assert.deepEqual([everywhere.scope, scoped.scope], ["all", "project"]);
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
