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

const dependencies = (kanban?: McpInvocationContext.McpInvocationScope["kanban"]) =>
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
      client: undefined,
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
        } as unknown as OrchestrationV2ThreadShell),
    }),
    Layer.mock(Project.ProjectService)({
      listShells: () =>
        Effect.succeed([
          { id: projectId, title: "Alpha" },
          { id: "project-b", title: "Beta" },
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

const harness = (kanban?: McpInvocationContext.McpInvocationScope["kanban"]) =>
  Effect.gen(function* () {
    const deps = Layer.succeedContext(yield* Layer.build(dependencies(kanban)));
    const toolkit = yield* NoteToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(NoteHandlers.layer).pipe(Layer.provide(deps)),
      ),
    );
    return (input: NoteParameters) =>
      toolkit.handle("t3_note", input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result as Record<string, unknown>),
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
    const call = yield* harness({ enabled: false, defaultBoard: "thread-project" });
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
