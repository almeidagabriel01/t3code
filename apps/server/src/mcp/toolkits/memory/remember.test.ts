import { expect, it } from "@effect/vitest";
import * as M from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AssistantDirectory } from "../../../assistants/AssistantDirectory.ts";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as Fixture from "./handlers.testkit.ts";

const decodeReceipt = Schema.decodeUnknownEffect(M.MemoryMutationReceipt);
const decodeRecall = Schema.decodeUnknownEffect(M.MemoryRecallResult);
const decodeRefusal = Schema.decodeUnknownEffect(M.OrchestratorMcpFailure);
const project = {
  environmentId: M.EnvironmentId.make("fixture-memory-mcp"),
  projectId: M.ProjectId.make("project-1"),
};
const caller = {
  ...Fixture.scope(),
  thread: {
    threadId: M.ThreadId.make("remember-thread"),
    providerSessionId: "synthetic",
    providerInstanceId: M.ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const seedThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT,occurred_at TEXT,application_event_version INTEGER,aggregate_kind TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,project_id TEXT,deleted_at TEXT)`;
  yield* sql`CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES ('project-1','/synthetic',NULL)`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('remember-thread','project-1',NULL)`;
  yield* sql`INSERT INTO orchestration_events VALUES (1,'00000000-0000-4000-8000-0000000000e1','remember-thread','thread.created','{}','2026-01-01T00:00:00.000Z',2,'thread')`;
  const service = yield* MemoryService.MemoryService;
  yield* service.updateProjectBinding(
    {
      memorySpaceId: Fixture.space,
      project,
      requestId: M.MemoryOperationId.make(Fixture.id(900)),
      expectedVersion: 0,
      action: "setExplicit",
      sharedProjectId: "shared-1",
    },
    Effect.void,
  );
});
const listAll = (scope: M.MemoryScope) =>
  Effect.gen(function* () {
    const service = yield* MemoryService.MemoryService;
    const page = yield* service.list(
      { memorySpaceId: Fixture.space, scope, includeQuarantined: false, limit: 20 },
      Effect.void,
    );
    return page.items;
  });

it.effect("remember derives scope, retries land on one memory, recall finds it", () =>
  Effect.gen(function* () {
    yield* seedThread;
    const first = yield* Fixture.call(
      "memory_remember",
      { text: "We deploy on Fridays", scope: "project" },
      caller,
    );
    expect(first.result.isError).not.toBe(true);
    const again = yield* Fixture.call(
      "memory_remember",
      { text: "  we deploy   on fridays ", scope: "project" },
      caller,
    );
    expect(again.result.isError).not.toBe(true);
    const items = yield* listAll({
      kind: "project",
      projectKey: { kind: "explicit", sharedProjectId: "shared-1" },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "active", payload: { text: expect.any(String) } });
    // Worded differently from the memory, and from the user scope's point of view.
    const recalled = yield* decodeRecall(
      (yield* Fixture.call("memory_recall", { query: "what did we decide about deploys?" }, caller))
        .body,
    );
    expect(recalled.items.map((item) => [item.scope, item.memoryId])).toEqual([
      ["project", (yield* decodeReceipt(first.body)).memoryId],
    ]);
    expect(Object.keys(recalled.items[0]!).sort()).toEqual([
      "createdAtUtc",
      "memoryId",
      "scope",
      "text",
    ]);
    // Another conversation without this project sees nothing of it.
    const none = yield* decodeRecall(
      (yield* Fixture.call("memory_recall", { query: "deploys" })).body,
    );
    expect(none.items).toEqual([]);
    expect(none.note).toBeDefined();
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("remember at user scope needs no thread and replaces by memoryId", () =>
  Effect.gen(function* () {
    const saved = yield* Fixture.call("memory_remember", { text: "Prefer tabs", scope: "user" });
    const id = (yield* decodeReceipt(saved.body)).memoryId;
    yield* Fixture.call("memory_remember", { text: "Prefer spaces", memoryId: id });
    const items = yield* listAll({ kind: "user" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ memoryId: id, payload: { text: "Prefer spaces" } });
    const read = yield* Fixture.call("memory_read", { memoryId: id });
    expect(read.body).toMatchObject({ memoryId: id, payload: { text: "Prefer spaces" } });
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("remember refuses project scope without project memory and unknown replacements", () =>
  Effect.gen(function* () {
    const noThread = yield* Fixture.call("memory_remember", { text: "x", scope: "project" });
    expect(noThread.result.isError).toBe(true);
    expect((yield* decodeRefusal(noThread.body)).message).toContain("scope user");
    expect(
      (yield* Fixture.call("memory_remember", { text: "x", memoryId: Fixture.id(77) })).result
        .isError,
    ).toBe(true);
    expect((yield* Fixture.call("memory_remember", { text: "x" })).result.isError).toBe(true);
  }).pipe(Effect.provide(Fixture.layer)),
);

const threadCaller = (
  threadId: string,
  capabilities: ReadonlyArray<"memory" | "orchestration">,
) => ({
  ...caller,
  capabilities: new Set(capabilities),
  thread: { ...caller.thread, threadId: M.ThreadId.make(threadId) },
});
const threadsOf = (body: unknown) =>
  Effect.map(decodeRecall(body), (result) => result.threads?.map((thread) => thread.threadId));

it.effect("recall adds at most five matching threads, hiding assistant threads from others", () =>
  Effect.gen(function* () {
    const result = yield* decodeRecall(
      (yield* Fixture.call(
        "memory_recall",
        { query: "deploys" },
        threadCaller("thread-9", ["memory", "orchestration"]),
      )).body,
    );
    expect(result.threads?.map((thread) => thread.threadId)).toEqual([
      "thread-1",
      "thread-2",
      "thread-3",
      "thread-4",
      "thread-5",
    ]);
    expect(result.threads?.[0]).toMatchObject({
      title: "Title thread-1",
      snippet: "about deploys",
    });
    expect(result.threads?.[0]?.updatedAt).toEqual(expect.any(String));
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("recall shows an assistant thread only to that assistant", () =>
  Effect.gen(function* () {
    expect(
      yield* threadsOf(
        (yield* Fixture.call(
          "memory_recall",
          { query: "deploys" },
          threadCaller("assistant:me", ["memory", "orchestration"]),
        )).body,
      ),
    ).toEqual(["thread-1", "assistant:me", "thread-2", "thread-3", "thread-4"]);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("recall without the orchestration capability returns no threads", () =>
  Effect.gen(function* () {
    expect(
      yield* threadsOf(
        (yield* Fixture.call(
          "memory_recall",
          { query: "deploys" },
          threadCaller("thread-9", ["memory"]),
        )).body,
      ),
    ).toBeUndefined();
  }).pipe(Effect.provide(Fixture.layer)),
);

// An assistant whose conversation lives in project-1 and also works in project-2 (through a group).
const assistantThread = M.ThreadId.make("assistant:ann:1");
const assistantCaller = { ...caller, thread: { ...caller.thread, threadId: assistantThread } };
const ann = {
  id: "ann",
  handle: "ann",
  scope: "project",
  projectId: "project-1",
  projectIds: ["project-1"],
} as unknown as M.Assistant;
const directory = AssistantDirectory.of({
  forThread: (threadId) =>
    threadId === assistantThread
      ? Effect.succeedSome({ assistant: ann, current: true })
      : Effect.succeedNone,
  teamsOf: () =>
    Effect.succeed([
      {
        team: {
          memberIds: ["ann"],
          archivedAt: null,
          projectIds: ["project-2"],
        } as unknown as M.AssistantTeam,
        lead: null,
        teammates: [],
      },
    ]),
  sandboxEnvironmentId: Effect.succeedNone,
  taskOwner: () => Effect.succeedNone,
  projectTitles: () => Effect.succeed({ "project-1": "Tudo-Azul", "project-2": "Apotek" }),
});
const seedSecondProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects VALUES ('project-2','/synthetic-2',NULL)`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${assistantThread},'project-1',NULL)`;
  const service = yield* MemoryService.MemoryService;
  yield* service.updateProjectBinding(
    {
      memorySpaceId: Fixture.space,
      project: { ...project, projectId: M.ProjectId.make("project-2") },
      requestId: M.MemoryOperationId.make(Fixture.id(901)),
      expectedVersion: 0,
      action: "setExplicit",
      sharedProjectId: "shared-2",
    },
    Effect.void,
  );
});
const projectMemories = (sharedProjectId: string) =>
  listAll({ kind: "project", projectKey: { kind: "explicit", sharedProjectId } });

it.effect("an assistant in several projects saves a project memory only where it names", () =>
  Effect.gen(function* () {
    yield* seedThread;
    yield* seedSecondProject;
    const saved = yield* Fixture.call(
      "memory_remember",
      { text: "Apotek deploys on Mondays", scope: "project", projectId: "project-2" },
      assistantCaller,
    );
    expect(saved.result.isError).not.toBe(true);
    expect(yield* projectMemories("shared-2")).toHaveLength(1);
    expect(yield* projectMemories("shared-1")).toHaveLength(0);

    // Unnamed, it would land in the conversation's (home) project, so it is refused.
    const unnamed = yield* Fixture.call(
      "memory_remember",
      { text: "Release freeze in December", scope: "project" },
      assistantCaller,
    );
    expect(unnamed.result.isError).toBe(true);
    expect((yield* decodeRefusal(unnamed.body)).message).toContain(
      "Tudo-Azul (id: project-1), Apotek (id: project-2)",
    );
    // A project it does not work in is refused too; nothing more was saved anywhere.
    const outside = yield* Fixture.call(
      "memory_remember",
      { text: "Other fact", scope: "project", projectId: "project-9" },
      assistantCaller,
    );
    expect((yield* decodeRefusal(outside.body)).message).toContain("not one of yours");
    expect(yield* projectMemories("shared-1")).toHaveLength(0);
    expect(yield* projectMemories("shared-2")).toHaveLength(1);

    // Recall from its home conversation reaches every one of its projects.
    const recalled = yield* decodeRecall(
      (yield* Fixture.call("memory_recall", { query: "when does Apotek deploy" }, assistantCaller))
        .body,
    );
    expect(recalled.items.map((item) => item.memoryId)).toEqual([
      (yield* decodeReceipt(saved.body)).memoryId,
    ]);
    // A conversation that is not a project assistant's cannot name a project.
    const plain = yield* Fixture.call(
      "memory_remember",
      { text: "x", scope: "project", projectId: "project-2" },
      caller,
    );
    expect((yield* decodeRefusal(plain.body)).message).toContain("leave it out");
  }).pipe(Effect.provideService(AssistantDirectory, directory), Effect.provide(Fixture.layer)),
);

it.effect("an assistant in several projects replaces a project memory by id alone", () =>
  Effect.gen(function* () {
    yield* seedThread;
    yield* seedSecondProject;
    const saved = yield* Fixture.call(
      "memory_remember",
      { text: "Apotek deploys on Mondays", scope: "project", projectId: "project-2" },
      assistantCaller,
    );
    const memoryId = (yield* decodeReceipt(saved.body)).memoryId;
    const replaced = yield* Fixture.call(
      "memory_remember",
      { text: "Apotek deploys on Tuesdays", scope: "project", memoryId },
      assistantCaller,
    );
    expect(replaced.result.isError).not.toBe(true);
    expect(yield* projectMemories("shared-2")).toMatchObject([
      { memoryId, payload: { text: "Apotek deploys on Tuesdays" } },
    ]);
  }).pipe(Effect.provideService(AssistantDirectory, directory), Effect.provide(Fixture.layer)),
);

it.effect("a project assistant reaches only its own projects' memories", () =>
  Effect.gen(function* () {
    yield* seedThread;
    yield* seedSecondProject;
    const service = yield* MemoryService.MemoryService;
    const outsideScope = {
      kind: "project",
      projectKey: { kind: "explicit", sharedProjectId: "shared-9" },
    } as const;
    const outsideId = M.MemoryId.make(Fixture.id(50));
    yield* service.upsert(
      { ...Fixture.upsert(51), memoryId: outsideId, scope: outsideScope },
      Effect.void,
    );
    const inside = (yield* decodeReceipt(
      (yield* Fixture.call(
        "memory_remember",
        { text: "Apotek deploys on Mondays", scope: "project", projectId: "project-2" },
        assistantCaller,
      )).body,
    )).memoryId;
    const insideScope = {
      kind: "project",
      projectKey: { kind: "explicit", sharedProjectId: "shared-2" },
    } as const;
    const refused = (name: string, input: object) =>
      Effect.gen(function* () {
        const out = yield* Fixture.call(name, input, assistantCaller);
        expect(out.result.isError).toBe(true);
        expect((yield* decodeRefusal(out.body)).message).toContain("not one of yours");
      });
    const allowed = (name: string, input: object) =>
      Effect.map(Fixture.call(name, input, assistantCaller), (out) =>
        expect(out.result.isError).not.toBe(true),
      );
    yield* refused("memory_list", { scope: outsideScope, includeQuarantined: false });
    yield* refused("memory_read", { memoryId: outsideId });
    yield* refused("memory_remember", { text: "Overwritten", memoryId: outsideId });
    expect(yield* projectMemories("shared-9")).toMatchObject([
      { memoryId: outsideId, payload: { text: "synthetic memory" } },
    ]);
    yield* allowed("memory_list", { scope: insideScope, includeQuarantined: false });
    yield* allowed("memory_read", { memoryId: inside });
    yield* allowed("memory_remember", { text: "Apotek deploys on Fridays", memoryId: inside });
    expect(yield* projectMemories("shared-2")).toMatchObject([
      { memoryId: inside, payload: { text: "Apotek deploys on Fridays" } },
    ]);
    // A forget retried after it landed still answers with its receipt.
    yield* service.upsert(Fixture.upsert(52), Effect.void);
    const user = yield* service.read(
      { memorySpaceId: Fixture.space, memoryId: Fixture.memoryId },
      Effect.void,
    );
    const forget = {
      memorySpaceId: Fixture.space,
      memoryId: Fixture.memoryId,
      operationId: M.MemoryOperationId.make(Fixture.id(53)),
      expectedHeads: user.status === "active" ? [user.revision.revisionId] : [],
    };
    const first = yield* Fixture.call("memory_forget", forget, assistantCaller);
    const retried = yield* Fixture.call("memory_forget", forget, assistantCaller);
    expect(retried.result.isError).not.toBe(true);
    expect(retried.body).toEqual(first.body);
  }).pipe(Effect.provideService(AssistantDirectory, directory), Effect.provide(Fixture.layer)),
);
