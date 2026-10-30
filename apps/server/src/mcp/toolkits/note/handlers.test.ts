import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as KanbanService from "../../../kanban/KanbanService.ts";
import * as NotesService from "../../../notes/NotesService.ts";
import * as NoteWorkService from "../../../notes/NoteWorkService.ts";
import { notesLayer } from "../../../notes/NotesTestkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as NoteHandlers from "./handlers.ts";
import { NoteToolkit, type NoteParameters } from "./tools.ts";

const projectId = ProjectId.make("project-a");
const providerInstanceId = ProviderInstanceId.make("codex");

interface Caller {
  readonly kanban?: McpInvocationContext.McpInvocationScope["kanban"];
  readonly client?: McpInvocationContext.McpInvocationScope["client"];
  readonly linkOrigin?: { sessionId: string; label: string; access: string };
}

const dependencies = ({ kanban, client, linkOrigin }: Caller = {}) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "thread:test",
      thread: {
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "session",
        providerInstanceId,
      },
      client,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
      ...(kanban === undefined ? {} : { kanban }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          projectId,
          deletedAt: null,
          archivedAt: null,
          activeRunId: "run-1",
          providerInstanceId,
          runtimeMode: "full-access",
          interactionMode: "default",
          ...(linkOrigin === undefined ? {} : { linkOrigin }),
        } as unknown as OrchestrationV2ThreadShell),
    }),
    Layer.mock(Project.ProjectService)({
      listShells: () =>
        Effect.succeed([
          { id: projectId, title: "Alpha" },
          { id: "project-b", title: "Beta" },
          { id: "project-g1", title: "Gamma" },
          { id: "project-g2", title: "gamma" },
        ] as unknown as ReadonlyArray<OrchestrationProjectShell>),
    }),
  ).pipe(
    Layer.provideMerge(
      NoteWorkService.layer.pipe(
        Layer.provideMerge(
          KanbanService.layer.pipe(
            Layer.provide(Layer.merge(SqlitePersistence.layerMemory, NodeCrypto.layer)),
          ),
        ),
        Layer.provideMerge(notesLayer()),
      ),
    ),
  );

const harness = (caller: Caller = {}) =>
  Effect.gen(function* () {
    const deps = Layer.succeedContext(yield* Layer.build(dependencies(caller)));
    const toolkit = yield* NoteToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(NoteHandlers.layer).pipe(Layer.provide(deps)),
      ),
    );
    return (input: NoteParameters) =>
      toolkit.handle("t3_note", input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result as Record<string, any>),
        Effect.provide(deps),
      );
  });

it.effect("an agent writes, retries a stale write after reading, and starts work on a card", () =>
  Effect.gen(function* () {
    const call = yield* harness();
    const created = yield* call({
      action: "write",
      path: "ideas/launch.md",
      body: "# Launch\n- [ ] plan\n",
      baseRevision: null,
    });
    expect(created).toMatchObject({ path: "ideas/launch.md", title: "Launch", updatedBy: "agent" });
    expect(created).not.toHaveProperty("body");

    const missing = yield* call({ action: "write", path: "ideas/launch.md", body: "x" });
    expect(missing).toMatchObject({ code: "invalid_request" });

    yield* call({
      action: "write",
      path: "ideas/launch.md",
      body: "# Launch\n- [x] plan\n",
      baseRevision: created.revision as string,
    });
    const stale = yield* call({
      action: "write",
      path: "ideas/launch.md",
      body: "# Launch\nstale\n",
      baseRevision: created.revision as string,
    });
    expect(stale).toMatchObject({ code: "invalid_request" });
    expect(stale.message).toContain("t3_note read");

    const read = yield* call({ action: "read", path: "ideas/launch.md" });
    expect(read.body).toBe("# Launch\n- [x] plan\n");
    const listed = yield* call({ action: "list", folder: "ideas" });
    expect(listed).toMatchObject({ folders: ["ideas"], truncated: false });
    const scoped = yield* call({ action: "update", path: "ideas/launch.md", project: "alpha" });
    expect(scoped).toMatchObject({ project: projectId });
    expect(yield* call({ action: "list", project: "Alpha" })).toMatchObject({
      notes: [{ path: "ideas/launch.md" }],
    });
    const unscoped = yield* call({
      action: "update",
      path: "ideas/launch.md",
      clearProject: true,
    });
    expect(unscoped).not.toHaveProperty("project");

    const started = yield* call({
      action: "start_work",
      path: "ideas/launch.md",
      clientRequestId: "request-1",
    });
    expect(started).toMatchObject({ card: { projectId }, cardId: expect.any(String) });
    const again = yield* call({
      action: "start_work",
      path: "ideas/launch.md",
      project: "alpha",
      clientRequestId: "request-1",
    });
    expect(again.cardId).toBe(started.cardId);

    const moved = yield* call({
      action: "move",
      path: "ideas/launch.md",
      to: "launch.md",
      baseRevision: again.revision as string,
    });
    expect(moved).toMatchObject({ path: "launch.md", id: created.id, card: started.card });
  }).pipe(Effect.scoped),
);

it.effect("start work respects the kanban agent setting", () =>
  Effect.gen(function* () {
    const call = yield* harness({ kanban: { enabled: false, defaultBoard: "thread-project" } });
    yield* call({ action: "write", path: "a.md", body: "# A\n", baseRevision: null });
    const refused = yield* call({ action: "start_work", path: "a.md" });
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect(refused.message).toContain("turned off");
  }).pipe(Effect.scoped),
);

it.effect("list and new notes default to this thread's project", () =>
  Effect.gen(function* () {
    const call = yield* harness();
    const paths = (result: Record<string, unknown>) =>
      (result.notes as ReadonlyArray<{ path: string }>).map((note) => note.path).toSorted();
    yield* call({ action: "write", path: "mine.md", body: "# Mine\n", baseRevision: null });
    yield* call({
      action: "write",
      path: "theirs.md",
      body: "# Theirs\n",
      baseRevision: null,
      project: "Beta",
    });
    const loose = yield* call({
      action: "write",
      path: "loose.md",
      body: "# Loose\n",
      baseRevision: null,
    });
    yield* call({ action: "update", path: "loose.md", clearProject: true });
    expect(loose).toMatchObject({ project: projectId });

    expect(paths(yield* call({ action: "list" }))).toEqual(["mine.md"]);
    expect(paths(yield* call({ action: "list", allProjects: true }))).toEqual([
      "loose.md",
      "mine.md",
      "theirs.md",
    ]);
    expect(paths(yield* call({ action: "list", project: "Beta" }))).toEqual(["theirs.md"]);
  }).pipe(Effect.scoped),
);

const STALE = "0".repeat(64) as never;

const writes: ReadonlyArray<NoteParameters> = [
  { action: "write", path: "new.md", body: "# New\n", baseRevision: null },
  { action: "update", path: "seed.md", pinned: true },
  { action: "move", path: "seed.md", to: "moved.md", baseRevision: STALE },
  { action: "start_work", path: "seed.md" },
];

const refusedWithNoEffect = <E>(
  call: (input: NoteParameters) => Effect.Effect<Record<string, any>, E>,
  code: string,
) =>
  Effect.gen(function* () {
    for (const input of writes) {
      expect(yield* call(input), input.action).toMatchObject({ code });
    }
    const listed = yield* call({ action: "list", allProjects: true });
    expect(listed.notes.map((note: { path: string }) => note.path)).toEqual(["seed.md"]);
    expect(listed.notes[0]).toMatchObject({ pinned: false, card: null });
  });

const seeded = (caller: Caller) =>
  Effect.gen(function* () {
    // The note exists before the restricted caller arrives, written through an unrestricted one.
    const dir = yield* NotesService.NotesService;
    yield* dir.write({ path: "seed.md", body: "# Seed\n", baseRevision: null }, "user");
    return yield* harness(caller);
  });

it.effect("a read-only client is refused every note write with no effect", () =>
  Effect.gen(function* () {
    const call = yield* seeded({
      client: { sessionId: "s", label: "Reader", access: "read-only" },
    });
    yield* refusedWithNoEffect(call, "capability_denied");
  }).pipe(Effect.provide(notesLayer()), Effect.scoped),
);

it.effect("work a below-full-access link started may read notes but not change them", () =>
  Effect.gen(function* () {
    const link = { sessionId: "link-1", label: "Laptop", access: "approval-required" };
    const call = yield* seeded({ linkOrigin: link });
    expect(yield* call({ action: "read", path: "seed.md" })).toMatchObject({ title: "Seed" });
    yield* refusedWithNoEffect(call, "capability_denied");

    const full = yield* harness({ linkOrigin: { ...link, access: "full-access" } });
    expect(yield* full({ action: "update", path: "seed.md", pinned: true })).toMatchObject({
      pinned: true,
    });
  }).pipe(Effect.provide(notesLayer()), Effect.scoped),
);

it.effect("each action names the parameter it is missing", () =>
  Effect.gen(function* () {
    const call = yield* harness();
    const cases: ReadonlyArray<readonly [NoteParameters, string]> = [
      [{ action: "read" }, "path"],
      [{ action: "write", body: "x", baseRevision: null }, "path"],
      [{ action: "write", path: "a.md", baseRevision: null }, "body"],
      [{ action: "write", path: "a.md", body: "x" }, "baseRevision"],
      [{ action: "update" }, "path"],
      [{ action: "move", to: "b.md", baseRevision: STALE }, "path"],
      [{ action: "move", path: "a.md", baseRevision: STALE }, "to"],
      [{ action: "move", path: "a.md", to: "b.md" }, "baseRevision"],
      [{ action: "move", path: "a.md", to: "b.md", baseRevision: null }, "baseRevision"],
      [{ action: "start_work" }, "path"],
    ];
    for (const [input, name] of cases) {
      const result = yield* call(input);
      expect(result, JSON.stringify(input)).toMatchObject({ code: "invalid_request" });
      expect(result.message).toContain(`\`${name}\``);
    }
    expect(yield* call({ action: "list", allProjects: true })).toMatchObject({ notes: [] });
  }).pipe(Effect.provide(notesLayer()), Effect.scoped),
);

it.effect.each(["../escape.md", "/abs.md", "a/../../escape.md", "plain.txt", "", "a//b.md"])(
  "the path %j is refused as a bad request and nothing is written",
  (path) =>
    Effect.gen(function* () {
      const call = yield* harness();
      for (const input of [
        { action: "write", path, body: "# X\n", baseRevision: null },
        { action: "read", path },
        { action: "start_work", path },
      ] as const) {
        expect(yield* call(input), input.action).toMatchObject({ code: "invalid_request" });
      }
      expect(yield* call({ action: "list", allProjects: true })).toMatchObject({ notes: [] });
    }).pipe(Effect.provide(notesLayer()), Effect.scoped),
);

it.effect("creating over an existing note and moving or reading a missing one are refused", () =>
  Effect.gen(function* () {
    const call = yield* harness();
    const first = yield* call({ action: "write", path: "a.md", body: "# A\n", baseRevision: null });
    const second = yield* call({
      action: "write",
      path: "a.md",
      body: "# B\n",
      baseRevision: null,
    });
    expect(second).toMatchObject({ code: "invalid_request" });
    expect((yield* call({ action: "read", path: "a.md" })).body).toBe("# A\n");

    expect(yield* call({ action: "read", path: "gone.md" })).toMatchObject({
      code: "invalid_request",
    });
    expect(
      yield* call({
        action: "move",
        path: "gone.md",
        to: "x.md",
        baseRevision: first.revision as string,
      }),
    ).toMatchObject({ code: "invalid_request" });
    expect(yield* call({ action: "start_work", path: "gone.md" })).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.provide(notesLayer()), Effect.scoped),
);

it.effect("a project name matching several projects or none is refused before any effect", () =>
  Effect.gen(function* () {
    const call = yield* harness();
    yield* call({ action: "write", path: "a.md", body: "# A\n", baseRevision: null });
    for (const project of ["Gamma", "nowhere"]) {
      for (const input of [
        { action: "update", path: "a.md", project },
        { action: "start_work", path: "a.md", project },
        { action: "write", path: "b.md", body: "# B\n", baseRevision: null, project },
        { action: "list", project },
      ] as const) {
        const result = yield* call(input);
        expect(result, `${project} ${input.action}`).toMatchObject({ code: "invalid_request" });
        expect(result.message).toContain("Use the project id");
      }
    }
    const listed = yield* call({ action: "list", allProjects: true });
    expect(listed.notes).toHaveLength(1);
    expect(listed.notes[0]).toMatchObject({ project: projectId });
    expect(listed.notes[0]).toMatchObject({ card: null });
    // An id wins over a title that also matches.
    expect(yield* call({ action: "update", path: "a.md", project: "project-g1" })).toMatchObject({
      project: "project-g1",
    });
  }).pipe(Effect.provide(notesLayer()), Effect.scoped),
);
