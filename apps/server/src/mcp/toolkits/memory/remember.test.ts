import { expect, it } from "@effect/vitest";
import * as M from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
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
