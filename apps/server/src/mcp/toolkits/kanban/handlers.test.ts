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
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as KanbanHandlers from "./handlers.ts";
import { applyChecklistOps } from "./checklistOps.ts";
import { KanbanToolkit, type KanbanParameters } from "./tools.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");
const providerInstanceId = ProviderInstanceId.make("codex");

const delegated: Array<{ task: string; title?: string | undefined }> = [];

const dependencies = (
  threadId: ThreadId,
  kanban?: McpInvocationContext.McpInvocationScope["kanban"],
) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "thread:test",
      thread: { threadId, providerSessionId: "session", providerInstanceId },
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
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      delegateTask: (_scope, input) => {
        delegated.push(input);
        return Effect.succeed({
          taskId: `task-${delegated.length}`,
          childThreadId: `child-${delegated.length}`,
        } as never);
      },
    }),
    Layer.mock(Project.ProjectService)({
      listShells: () =>
        Effect.succeed([
          { id: projectId, title: "Alpha" },
          { id: otherProjectId, title: "Beta" },
        ] as unknown as ReadonlyArray<OrchestrationProjectShell>),
    }),
  ).pipe(
    Layer.provideMerge(
      KanbanService.layer.pipe(
        Layer.provide(Layer.merge(SqlitePersistence.layerMemory, NodeCrypto.layer)),
      ),
    ),
  );

const harness = (kanbanSettings?: McpInvocationContext.McpInvocationScope["kanban"]) =>
  Effect.gen(function* () {
    const deps = Layer.succeedContext(
      yield* Layer.build(dependencies(ThreadId.make("thread-1"), kanbanSettings)),
    );
    const toolkit = yield* KanbanToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(KanbanHandlers.layer).pipe(Layer.provide(deps)),
      ),
    );
    const kanban = yield* KanbanService.KanbanService.pipe(Effect.provide(deps));
    const call = (input: KanbanParameters) =>
      toolkit.handle("t3_kanban", input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result as Record<string, any>),
        Effect.provide(deps),
      );
    return { call, kanban };
  });

it.effect(
  "an agent plans cards, ticks the checklist and finishes through the definition of done",
  () =>
    Effect.gen(function* () {
      const { call } = yield* harness();
      const created = yield* call({
        action: "create_card",
        title: "Fix login",
        type: "bug",
        labels: ["auth"],
        checklist: ["Reproduce", "Fix"],
        linkSelf: true,
      });
      expect(created).toMatchObject({ number: 1, column: "To do", labels: ["auth"], threads: 1 });
      expect(created.checklist).toHaveLength(2);

      const again = yield* call({
        action: "create_card",
        title: "Two",
        labels: ["Auth"],
        column: "todo",
      });
      expect(again).toMatchObject({ number: 2, column: "To do", labels: ["auth"] });

      // Defaults to the card linked to this thread.
      const refused = yield* call({ action: "move_card", column: "review", summary: "Done" });
      expect(refused).toMatchObject({ code: "invalid_request" });
      expect(refused.message).toContain("checklist item not done: Reproduce");

      yield* call({
        action: "update_card",
        checklist: [{ item: "reproduce", done: true }, { item: "Fix", done: true }, "Add a test"],
      });
      const stillOpen = yield* call({ action: "move_card", column: "review", summary: "Done" });
      expect(stillOpen.message).toContain("Add a test");
      yield* call({ action: "update_card", checklist: [{ item: "Add a test", done: true }] });
      const noSummary = yield* call({ action: "move_card", column: "review" });
      expect(noSummary.message).toContain("completion summary");
      const moved = yield* call({
        action: "move_card",
        column: "review",
        summary: "Fixed and tested.",
      });
      expect(moved).toMatchObject({
        number: 1,
        column: "Review",
        checklist: [{ done: true }, { done: true }, { done: true }],
      });

      const detail = yield* call({ action: "read_card", card: "#1" });
      expect(detail.activity.map((event: { kind: string }) => event.kind)).toContain("dod-refused");
      expect(detail.activity.at(-1)).toMatchObject({ kind: "moved" });

      const board = yield* call({ action: "read_board", column: "review" });
      expect(board.cards).toHaveLength(1);
      expect(board.matching).toBe(1);
      const boards = yield* call({ action: "list_boards" });
      expect(boards.boards).toMatchObject([{ project: "Alpha" }]);
    }).pipe(Effect.scoped),
);

it.effect("targets another project by name and reads without creating a board", () =>
  Effect.gen(function* () {
    const { call, kanban } = yield* harness();
    const missing = yield* call({ action: "read_board", project: "Beta" });
    expect(missing).toMatchObject({ code: "invalid_request" });
    expect((yield* call({ action: "list_boards" })).boards).toHaveLength(0);

    const created = yield* call({
      action: "create_card",
      project: "beta",
      title: "Elsewhere",
      column: "done",
    });
    expect(created).toMatchObject({ number: 1, column: "Done" });
    const none = yield* call({ action: "create_card", title: "Here", column: "nope" });
    expect(none.message).toContain("Unknown column");
    expect(yield* call({ action: "comment", body: "x" })).toMatchObject({
      code: "invalid_request",
    });
    yield* call({ action: "comment", card: "#1", project: "Beta", body: "Progress" });
    const card = yield* call({ action: "read_card", card: "#1", project: "Beta" });
    expect(card.activity.at(-1)).toMatchObject({
      kind: "comment",
      payload: { body: "Progress" },
      actor: "agent:thread-1",
    });
    void kanban;
  }).pipe(Effect.scoped),
);

it.effect("a create retried with the same clientRequestId makes one card", () =>
  Effect.gen(function* () {
    const { call } = yield* harness();
    const first = yield* call({ action: "create_card", title: "Once", clientRequestId: "k1" });
    const second = yield* call({ action: "create_card", title: "Once", clientRequestId: "k1" });
    expect(second.id).toBe(first.id);
    expect((yield* call({ action: "read_board" })).matching).toBe(1);
  }).pipe(Effect.scoped),
);

it("applies checklist edits by id or text and reports ambiguity", () => {
  const items = [
    { id: "a", text: "Write", done: false },
    { id: "b", text: "write", done: false },
    { id: "c", text: "Ship", done: false },
  ];
  expect(
    applyChecklistOps(items, [{ item: "c", done: true, text: "Ship it" }, "New"]).items,
  ).toEqual([
    items[0],
    items[1],
    { id: "c", text: "Ship it", done: true },
    { text: "New", done: false },
  ]);
  expect(applyChecklistOps(items, [{ item: "SHIP", done: true }]).items[2]).toMatchObject({
    done: true,
  });
  expect(applyChecklistOps(items, [{ item: "write" }]).error).toContain("Several");
  const ticked = applyChecklistOps(
    [{ text: "Ship it", done: false }],
    [{ text: "ship it", done: true }],
  );
  expect(ticked.items).toEqual([{ text: "Ship it", done: true }]);
  expect(applyChecklistOps(items, [{ item: "c", remove: true }]).items).toEqual([
    items[0],
    items[1],
  ]);
  expect(applyChecklistOps(items, [{ item: "write", remove: true }]).items).toEqual([
    items[1],
    items[2],
  ]);
  expect(applyChecklistOps(items, [{ item: "nope", remove: true }]).error).toContain(
    "No checklist",
  );
  expect(applyChecklistOps(items, [{ item: "nope" }]).error).toContain("No checklist items");
  expect(applyChecklistOps(items, [{ done: true }]).error).toContain("needs `text`");
});

it.effect("with the tool setting off, calls are refused and the tool is hidden", () =>
  Effect.gen(function* () {
    const { call } = yield* harness({ enabled: false, defaultBoard: "thread-project" });
    expect(yield* call({ action: "list_boards" })).toMatchObject({ code: "invalid_request" });
    const hiddenIn = (kanban: McpInvocationContext.McpInvocationScope["kanban"]) =>
      Effect.sync(() => McpInvocationContext.hiddenWhileKanbanOff()).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "x",
          thread: undefined,
          client: undefined,
          issuedAt: 0,
          capabilities: new Set<"orchestration">(),
          ...(kanban === undefined ? {} : { kanban }),
        }),
      );
    expect(yield* hiddenIn({ enabled: false, defaultBoard: "ask" })).toBe(false);
    expect(yield* hiddenIn({ enabled: true, defaultBoard: "ask" })).toBe(true);
    expect(yield* hiddenIn(undefined)).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("the ask setting needs a project unless the thread's card is linked", () =>
  Effect.gen(function* () {
    const { call } = yield* harness({ enabled: true, defaultBoard: "ask" });
    const refused = yield* call({ action: "create_card", title: "A" });
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect(refused.message).toContain("Projects: Alpha, Beta");
    expect(yield* call({ action: "read_board" })).toMatchObject({ code: "invalid_request" });
    const created = yield* call({
      action: "create_card",
      title: "A",
      project: "Alpha",
      linkSelf: true,
    });
    expect(created).toMatchObject({ number: 1, threads: 1 });
    // The linked card needs no project.
    expect(yield* call({ action: "read_card" })).toMatchObject({ number: 1 });
    expect(yield* call({ action: "comment", body: "hi" })).toMatchObject({ commented: 1 });
    expect(yield* call({ action: "list_boards" })).toMatchObject({
      boards: [{ project: "Alpha" }],
    });
  }).pipe(Effect.scoped),
);

it.effect("an agent splits a card into subtasks and starts a subagent for each open one", () =>
  Effect.gen(function* () {
    delegated.length = 0;
    const { call, kanban } = yield* harness();
    const parent = yield* call({ action: "create_card", title: "Big feature" });
    const first = yield* call({ action: "create_card", title: "Backend", parent: "#1" });
    yield* call({ action: "create_card", title: "Frontend", parent: "#1", description: "Wire it" });
    const done = yield* call({ action: "create_card", title: "Docs", parent: "#1" });
    expect(first).toMatchObject({ number: 2, parent: "#1 Big feature" });
    expect(parent).toMatchObject({ number: 1 });

    const nested = yield* call({ action: "create_card", title: "Nope", parent: "#2" });
    expect(nested).toMatchObject({ code: "invalid_request" });

    yield* call({ action: "move_card", card: "#4", column: "done", summary: "ok" });
    expect(done).toMatchObject({ number: 4 });
    const read = yield* call({ action: "read_card", card: "#1" });
    expect(read).toMatchObject({ subtasks: "1/3 done" });
    expect(read.subtaskList.map((item: { number: number }) => item.number)).toEqual([2, 3, 4]);

    const started = yield* call({ action: "start_agents", card: "#1", isolation: "worktree" });
    expect(started.started).toMatchObject([
      { card: 2, threadId: "child-1" },
      { card: 3, threadId: "child-2" },
    ]);
    expect(delegated.map((entry) => entry.title)).toEqual(["#2 Backend", "#3 Frontend"]);
    expect(delegated[1]!.task).toContain("a subtask of #1");
    expect(delegated[1]!.task).toContain("Wire it");

    // Linked subtasks are not started twice.
    const again = yield* call({ action: "start_agents", card: "#1" });
    expect(again).toMatchObject({ started: [], note: "No open subtask without a thread." });
    const family = (yield* kanban.cardFamily((read as { id: never }).id))!;
    expect(family.subtasks.map((card) => card.linkedThreadIds.length)).toEqual([1, 1, 0]);
  }),
);
