import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  OrchestratorMcpFailure,
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
const failingTitles = new Set<string>();

interface LinkOrigin {
  sessionId: string;
  label: string;
  access: "approval-required" | "full-access";
}

interface Caller {
  /** The link that started the calling thread; read on every call so a test can set it later. */
  readonly link?: { current: LinkOrigin | undefined };
  readonly kanban?: McpInvocationContext.McpInvocationScope["kanban"];
  readonly client?: McpInvocationContext.McpInvocationScope["client"];
  /** Shells other than the caller's: null is a thread that does not exist. */
  readonly threads?: Record<string, { projectId: ProjectId; deletedAt?: string } | null>;
}

const dependencies = (threadId: ThreadId, { kanban, client, threads, link }: Caller = {}) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "thread:test",
      thread: { threadId, providerSessionId: "session", providerInstanceId },
      client,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
      ...(kanban === undefined ? {} : { kanban }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          threads?.[id] === null
            ? null
            : ({
                id,
                projectId: threads?.[id]?.projectId ?? projectId,
                deletedAt: threads?.[id]?.deletedAt ?? null,
                archivedAt: null,
                activeRunId: "run-1",
                providerInstanceId,
                runtimeMode: "full-access",
                interactionMode: "default",
                ...(id === threadId && link?.current !== undefined
                  ? { linkOrigin: link.current }
                  : {}),
              } as unknown as OrchestrationV2ThreadShell),
        ),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      delegateTask: (_scope, input) => {
        delegated.push(input);
        if (input.title !== undefined && failingTitles.has(input.title)) {
          return Effect.fail(
            new OrchestratorMcpFailure({ code: "invalid_request", message: "no" }),
          );
        }
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

const harness = (caller: Caller = {}) =>
  Effect.gen(function* () {
    const link: NonNullable<Caller["link"]> = { current: undefined };
    const deps = Layer.succeedContext(
      yield* Layer.build(dependencies(ThreadId.make("thread-1"), { ...caller, link })),
    );
    const toolkit = yield* KanbanToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(KanbanHandlers.layer).pipe(Layer.provide(deps)),
      ),
    );
    const kanban = yield* KanbanService.KanbanService.pipe(Effect.provide(deps));
    const scope = yield* McpInvocationContext.McpInvocationContext.pipe(Effect.provide(deps));
    const callAs =
      (client: McpInvocationContext.McpInvocationScope["client"]) => (input: KanbanParameters) =>
        toolkit.handle("t3_kanban", input).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((results) => results.at(-1)?.result as Record<string, any>),
          Effect.provideService(McpInvocationContext.McpInvocationContext, { ...scope, client }),
          Effect.provide(deps),
        );
    return { call: callAs(scope.client), callAs, kanban, link };
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
    const { call } = yield* harness({ kanban: { enabled: false, defaultBoard: "thread-project" } });
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
    const { call } = yield* harness({ kanban: { enabled: true, defaultBoard: "ask" } });
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

it.effect("a below-full-access link's thread reads boards but cannot change them", () =>
  Effect.gen(function* () {
    delegated.length = 0;
    const { call, link } = yield* harness();
    yield* call({ action: "create_card", title: "Parent" });
    yield* call({ action: "create_card", title: "Child", parent: "#1" });
    const before = (yield* call({ action: "read_board" })).cards;

    const writes: ReadonlyArray<KanbanParameters> = [
      { action: "create_card", title: "Sneaky" },
      { action: "update_card", card: "#1", title: "Renamed" },
      { action: "move_card", card: "#1", column: "done", summary: "x" },
      { action: "comment", card: "#1", body: "hi" },
      { action: "link_thread", card: "#1", threadId: ThreadId.make("thread-9") },
      { action: "unlink_thread", card: "#1" },
      { action: "start_agents", card: "#1" },
    ];
    link.current = { sessionId: "link-1", label: "Laptop", access: "approval-required" };
    expect(yield* call({ action: "read_card", card: "#1" })).toMatchObject({ number: 1 });
    expect((yield* call({ action: "list_boards" })).boards).toHaveLength(1);
    for (const input of writes) {
      expect(yield* call(input), input.action).toMatchObject({ code: "capability_denied" });
    }
    link.current = undefined;
    expect((yield* call({ action: "read_board" })).cards).toEqual(before);
    expect((yield* call({ action: "read_card", card: "#1" })).activity).toHaveLength(1);
    expect(delegated).toEqual([]);

    // A link paired with full access is not fenced.
    link.current = { sessionId: "link-1", label: "Laptop", access: "full-access" };
    expect(yield* call({ action: "comment", card: "#1", body: "ok" })).toMatchObject({
      commented: 1,
    });
  }).pipe(Effect.scoped),
);

it.effect("a read-only client is refused every write before it runs", () =>
  Effect.gen(function* () {
    delegated.length = 0;
    const { call, callAs } = yield* harness();
    yield* call({ action: "create_card", title: "Parent" });
    const readOnly = callAs({ sessionId: "s", label: "Reader", access: "read-only" });
    for (const input of [
      { action: "create_card", title: "Sneaky" },
      { action: "comment", card: "#1", body: "hi" },
      { action: "start_agents", card: "#1" },
    ] as const) {
      expect(yield* readOnly(input), input.action).toMatchObject({ code: "capability_denied" });
    }
    expect((yield* call({ action: "read_board" })).matching).toBe(1);
    expect(delegated).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("each action names the parameter it is missing, and bad references change nothing", () =>
  Effect.gen(function* () {
    const { call } = yield* harness();
    yield* call({ action: "create_card", title: "Keep", linkSelf: true });
    const cases: ReadonlyArray<readonly [KanbanParameters, string]> = [
      [{ action: "create_card" }, "title"],
      [{ action: "create_card", title: "   " }, "title"],
      [{ action: "move_card" }, "column"],
      [{ action: "comment" }, "body"],
      [{ action: "comment", body: "  " }, "body"],
    ];
    for (const [input, name] of cases) {
      const result = yield* call(input);
      expect(result, JSON.stringify(input)).toMatchObject({ code: "invalid_request" });
      expect(result.message).toContain(`\`${name}\``);
    }
    const refused: ReadonlyArray<readonly [KanbanParameters, string]> = [
      [{ action: "create_card", title: "T", type: "nope" }, "Unknown type"],
      [{ action: "update_card", title: "Changed", type: "nope" }, "Unknown type"],
      [{ action: "move_card", column: "nope" }, "Unknown column"],
      [{ action: "read_card", card: "#99" }, "not on the"],
      [{ action: "read_card", card: "missing-id" }, "was not found"],
      [{ action: "update_card", card: "#99", title: "X" }, "not on the"],
      [{ action: "update_card", checklist: [{ item: "ghost" }] }, "No checklist"],
      [{ action: "create_card", title: "T", parent: "#99" }, "not on the"],
      [{ action: "read_board", column: "nope" }, "Unknown column"],
    ];
    for (const [input, message] of refused) {
      const result = yield* call(input);
      expect(result, JSON.stringify(input)).toMatchObject({ code: "invalid_request" });
      expect(result.message).toContain(message);
    }
    const board = yield* call({ action: "read_board" });
    expect(board.matching).toBe(1);
    expect(board.cards[0]).toMatchObject({ title: "Keep", checklist: "0/0" });
    expect(board.labels).toEqual([]);
    const card = yield* call({ action: "read_card" });
    expect(card.activity.map((event: { kind: string }) => event.kind)).toEqual([
      "created",
      "linked",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("read_board filters by label and text, counts every match, and cuts at the limit", () =>
  Effect.gen(function* () {
    const { call } = yield* harness();
    yield* call({ action: "create_card", title: "Fix Login", labels: ["Auth"] });
    yield* call({ action: "create_card", title: "Docs", description: "login page copy" });
    yield* call({ action: "create_card", title: "Ünïcode café", column: "done" });
    const titles = (result: Record<string, any>) => result.cards.map((card: any) => card.title);

    expect(titles(yield* call({ action: "read_board", label: "auth" }))).toEqual(["Fix Login"]);
    expect(titles(yield* call({ action: "read_board", text: "LOGIN" }))).toEqual([
      "Fix Login",
      "Docs",
    ]);
    expect(titles(yield* call({ action: "read_board", text: "café" }))).toEqual(["Ünïcode café"]);
    const cut = yield* call({ action: "read_board", limit: 1 });
    expect(cut).toMatchObject({ matching: 3 });
    expect(cut.cards).toHaveLength(1);
    // Cards are listed in column order, so the done card comes last.
    expect(titles(yield* call({ action: "read_board" })).at(-1)).toBe("Ünïcode café");
    expect(yield* call({ action: "read_board", text: "zzz" })).toMatchObject({
      matching: 0,
      cards: [],
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "an archived card is hidden from the board and cannot be found, moved or commented on",
  () =>
    Effect.gen(function* () {
      const { call, kanban } = yield* harness();
      const created = yield* call({ action: "create_card", title: "Old" });
      yield* kanban.cardArchive({
        commandId: CommandId.make("archive"),
        cardId: created.id,
        actor: "user",
      });
      expect((yield* call({ action: "read_board" })).matching).toBe(0);
      expect(yield* call({ action: "read_card", card: "#1" })).toMatchObject({
        code: "invalid_request",
      });
      const moved = yield* call({ action: "move_card", card: created.id, column: "done" });
      expect(moved).toMatchObject({ code: "invalid_request" });
      expect(moved.message).toContain("was not found");
      expect(yield* call({ action: "comment", card: created.id, body: "x" })).toMatchObject({
        code: "invalid_request",
      });
      const detail = yield* kanban.getCard({ cardId: created.id });
      expect(detail.activity.map((event) => event.kind)).toEqual(["created", "archived"]);
    }).pipe(Effect.scoped),
);

it.effect("linking a thread needs a live thread of the board's project not on another card", () =>
  Effect.gen(function* () {
    const { call } = yield* harness({
      threads: {
        "other-project": { projectId: otherProjectId },
        gone: null,
        deleted: { projectId, deletedAt: "2026-01-01T00:00:00.000Z" },
        fine: { projectId },
      },
    });
    yield* call({ action: "create_card", title: "A" });
    yield* call({ action: "create_card", title: "B" });
    for (const threadId of ["other-project", "gone", "deleted"]) {
      const result = yield* call({
        action: "link_thread",
        card: "#1",
        threadId: ThreadId.make(threadId),
      });
      expect(result, threadId).toMatchObject({ code: "invalid_request" });
    }
    expect((yield* call({ action: "read_card", card: "#1" })).linkedThreadIds).toEqual([]);

    const linked = yield* call({ action: "link_thread", card: "#1", threadId: "fine" as never });
    expect(linked.linkedThreadIds).toEqual(["fine"]);
    const twice = yield* call({ action: "link_thread", card: "#2", threadId: "fine" as never });
    expect(twice).toMatchObject({ code: "invalid_request" });
    expect(twice.message).toContain("already linked");
    expect((yield* call({ action: "read_card", card: "#2" })).linkedThreadIds).toEqual([]);
    // Linking and unlinking are repeatable.
    expect(
      (yield* call({ action: "link_thread", card: "#1", threadId: "fine" as never }))
        .linkedThreadIds,
    ).toEqual(["fine"]);
    const unlinked = yield* call({
      action: "unlink_thread",
      card: "#1",
      threadId: "fine" as never,
    });
    expect(unlinked.linkedThreadIds).toEqual([]);
    expect(
      (yield* call({ action: "unlink_thread", card: "#1", threadId: "fine" as never }))
        .linkedThreadIds,
    ).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("a subtask brief cuts a long description on a whole character", () =>
  Effect.gen(function* () {
    delegated.length = 0;
    const { call } = yield* harness();
    yield* call({ action: "create_card", title: "Parent" });
    yield* call({
      action: "create_card",
      title: "Long",
      parent: "#1",
      description: "d".repeat(3_999) + "😀 tail",
    });
    yield* call({ action: "start_agents", card: "#1" });
    const task = delegated[0]!.task;
    expect(task.endsWith("d".repeat(3_999))).toBe(true);
    expect(task).not.toContain("tail");
  }).pipe(Effect.scoped),
);

it.effect("start_agents reports a failed subagent, starts the rest, and caps one call", () =>
  Effect.gen(function* () {
    delegated.length = 0;
    failingTitles.clear();
    const { call } = yield* harness();
    yield* call({ action: "create_card", title: "Parent" });
    for (let index = 1; index <= 10; index += 1) {
      yield* call({ action: "create_card", title: `Part ${index}`, parent: "#1" });
    }
    failingTitles.add("#3 Part 2");
    const first = yield* call({ action: "start_agents", card: "#1" });
    expect(first.started).toHaveLength(8);
    expect(first.started[1]).toMatchObject({ card: 3, error: "no" });
    expect(first.started[2]).toMatchObject({ card: 4, threadId: expect.any(String) });
    expect(first.notStarted).toBe(2);

    // The failed one and the two beyond the cap are still open; started ones are not repeated.
    failingTitles.clear();
    const second = yield* call({ action: "start_agents", card: "#1" });
    expect(second.started.map((entry: { card: number }) => entry.card)).toEqual([3, 10, 11]);
    expect(second.notStarted).toBe(0);
    expect((yield* call({ action: "read_card", card: "#1" })).subtasks).toBe("0/10 done");
  }).pipe(Effect.scoped),
);

it.effect("a create retried with the same clientRequestId keeps the first card's fields", () =>
  Effect.gen(function* () {
    const { call } = yield* harness();
    const first = yield* call({ action: "create_card", title: "First", clientRequestId: "k9" });
    const retry = yield* call({
      action: "create_card",
      title: "Different",
      labels: ["new"],
      clientRequestId: "k9",
    });
    expect(retry).toMatchObject({ id: first.id, title: "First" });
    const board = yield* call({ action: "read_board" });
    expect(board.matching).toBe(1);
    // A move retried by id lands once.
    const move = {
      action: "move_card",
      card: "#1",
      column: "done",
      summary: "ok",
      clientRequestId: "m1",
    } as const;
    yield* call(move);
    yield* call(move);
    const activity = (yield* call({ action: "read_card", card: "#1" })).activity;
    expect(activity.filter((event: { kind: string }) => event.kind === "moved")).toHaveLength(1);
  }).pipe(Effect.scoped),
);
