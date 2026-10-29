import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  KanbanError,
  ProjectId,
  ThreadId,
  type KanbanBoardSnapshot,
  type KanbanStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CardImages from "./CardImages.ts";
import * as Kanban from "./KanbanService.ts";

const TestLayer = Kanban.layer.pipe(
  Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, NodeCrypto.layer)),
);

const isKanbanError = Schema.is(KanbanError);

let commandCounter = 0;
const cmd = () => CommandId.make(`command-${++commandCounter}`);

const setup = Effect.gen(function* () {
  const kanban = yield* Kanban.KanbanService;
  const ensured = yield* kanban.boardEnsure({ commandId: cmd(), projectId: ProjectId.make("p1") });
  const board = yield* snapshotBoard(kanban, ensured.boardId!);
  const column = (role: string) => board.columns.find((c) => c.role === role)!;
  return { kanban, boardId: board.id, board, column };
});

const snapshotBoard = (kanban: Kanban.KanbanService["Service"], boardId: string) =>
  kanban.subscribe().pipe(
    Stream.runHead,
    Effect.map((head) => {
      const item = (head as { value: KanbanStreamItem }).value;
      assert.equal(item.kind, "snapshot");
      return (item as { boards: ReadonlyArray<KanbanBoardSnapshot> }).boards.find(
        (b) => b.id === boardId,
      )!;
    }),
  );

const titlesIn = (board: KanbanBoardSnapshot, columnId: string) =>
  board.cards.filter((card) => card.columnId === columnId).map((card) => card.title);

it.effect("ensure creates the default board once", () =>
  Effect.gen(function* () {
    const { kanban, board } = yield* setup;
    assert.deepEqual(
      board.columns.map((c) => [c.name, c.role]),
      [
        ["Backlog", "backlog"],
        ["To do", "todo"],
        ["In progress", "in-progress"],
        ["Review", "review"],
        ["Done", "done"],
      ],
    );
    assert.deepEqual(
      board.templates.map((t) => t.name),
      ["Bug", "Feature", "Refactor", "Chore"],
    );
    const again = yield* kanban.boardEnsure({ commandId: cmd(), projectId: ProjectId.make("p1") });
    assert.equal(again.boardId, board.id);
    assert.equal(again.sequence, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("creates, moves and reorders cards with per-board numbers", () =>
  Effect.gen(function* () {
    const { kanban, boardId, column } = yield* setup;
    const backlog = column("backlog");
    const ids = [];
    for (const title of ["A", "B", "C"]) {
      ids.push(yield* kanban.cardCreate({ commandId: cmd(), boardId, title }));
    }
    assert.deepEqual(
      ids.map((r) => r.number),
      [1, 2, 3],
    );
    yield* kanban.cardMove({
      commandId: cmd(),
      cardId: ids[2]!.cardId!,
      columnId: backlog.id,
      beforeCardId: ids[0]!.cardId!,
    });
    yield* kanban.cardMove({
      commandId: cmd(),
      cardId: ids[0]!.cardId!,
      columnId: column("todo").id,
    });
    let board = yield* snapshotBoard(kanban, boardId);
    assert.deepEqual(titlesIn(board, backlog.id), ["C", "B"]);
    assert.deepEqual(titlesIn(board, column("todo").id), ["A"]);
    yield* kanban.cardMove({
      commandId: cmd(),
      cardId: ids[1]!.cardId!,
      columnId: backlog.id,
      afterCardId: ids[2]!.cardId!,
    });
    board = yield* snapshotBoard(kanban, boardId);
    assert.deepEqual(titlesIn(board, backlog.id), ["C", "B"]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps order keys short and ordering stable across many appends", () =>
  Effect.gen(function* () {
    const { kanban, boardId } = yield* setup;
    const titles = Array.from({ length: 40 }, (_, i) => `card-${i}`);
    for (const title of titles) yield* kanban.cardCreate({ commandId: cmd(), boardId, title });
    const board = yield* snapshotBoard(kanban, boardId);
    assert.deepEqual(
      board.cards.map((c) => c.title),
      titles,
    );
    assert.isTrue(board.cards.every((c) => c.orderKey.length <= 16));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("seeds template checklists and keeps checklist ids stable on update", () =>
  Effect.gen(function* () {
    const { kanban, boardId, board } = yield* setup;
    const bug = board.templates.find((t) => t.name === "Bug")!;
    const created = yield* kanban.cardCreate({
      commandId: cmd(),
      boardId,
      title: "Crash",
      type: bug.id,
    });
    const card = (yield* kanban.getCard({ cardId: created.cardId! })).card;
    assert.equal(card.priority, bug.priority);
    assert.deepEqual(
      card.checklist.map((i) => i.text),
      bug.checklist,
    );
    const first = card.checklist[0]!;
    yield* kanban.cardUpdate({
      commandId: cmd(),
      cardId: card.id,
      checklist: [
        { id: first.id, text: first.text, done: true },
        { text: "extra", done: false },
      ],
    });
    const updated = (yield* kanban.getCard({ cardId: card.id })).card;
    assert.equal(updated.checklist[0]!.id, first.id);
    assert.isTrue(updated.checklist[0]!.done);
    assert.equal(updated.checklist.length, 2);
    assert.notEqual(updated.checklist[1]!.id, first.id);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("setting a type later seeds an empty card from the template", () =>
  Effect.gen(function* () {
    const { kanban, boardId, board } = yield* setup;
    const bug = board.templates.find((t) => t.name === "Bug")!;
    const created = yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "Crash" });
    yield* kanban.cardUpdate({ commandId: cmd(), cardId: created.cardId!, type: bug.id });
    const card = (yield* kanban.getCard({ cardId: created.cardId! })).card;
    assert.deepEqual(
      card.checklist.map((i) => i.text),
      bug.checklist,
    );
    assert.deepEqual(
      card.acceptanceCriteria.map((i) => i.text),
      bug.acceptanceCriteria,
    );
    assert.equal(card.priority, bug.priority);
    assert.deepEqual(card.labelIds, bug.labelIds);

    const mine = yield* kanban.cardCreate({
      commandId: cmd(),
      boardId,
      title: "Own list",
      checklist: [{ text: "mine", done: false }],
    });
    yield* kanban.cardUpdate({ commandId: cmd(), cardId: mine.cardId!, type: bug.id });
    const kept = (yield* kanban.getCard({ cardId: mine.cardId! })).card;
    assert.deepEqual(
      kept.checklist.map((i) => i.text),
      ["mine"],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("deleting a column moves live and archived cards to the target", () =>
  Effect.gen(function* () {
    const { kanban, boardId, column } = yield* setup;
    const qa = yield* kanban.columnCreate({ commandId: cmd(), boardId, name: "QA" });
    const todo = column("todo");
    yield* kanban.cardCreate({ commandId: cmd(), boardId, columnId: todo.id, title: "existing" });
    const one = yield* kanban.cardCreate({
      commandId: cmd(),
      boardId,
      columnId: qa.columnId!,
      title: "one",
    });
    yield* kanban.cardCreate({ commandId: cmd(), boardId, columnId: qa.columnId!, title: "two" });
    const gone = yield* kanban.cardCreate({
      commandId: cmd(),
      boardId,
      columnId: qa.columnId!,
      title: "gone",
    });
    yield* kanban.cardArchive({ commandId: cmd(), cardId: gone.cardId! });

    const sameTarget = yield* kanban
      .columnDelete({ commandId: cmd(), columnId: qa.columnId!, targetColumnId: qa.columnId! })
      .pipe(Effect.flip);
    assert.equal(sameTarget.kind, "invalid");

    yield* kanban.columnDelete({
      commandId: cmd(),
      columnId: qa.columnId!,
      targetColumnId: todo.id,
    });
    const board = yield* snapshotBoard(kanban, boardId);
    assert.isFalse(board.columns.some((c) => c.id === qa.columnId));
    assert.deepEqual(titlesIn(board, todo.id), ["existing", "one", "two"]);
    const archived = yield* kanban.listArchived({ boardId });
    assert.equal(archived.cards[0]!.columnId, todo.id);
    assert.equal(one.cardId !== undefined, true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("allows at most one column per non-none role", () =>
  Effect.gen(function* () {
    const { kanban, boardId, column } = yield* setup;
    const duplicate = yield* kanban
      .columnCreate({ commandId: cmd(), boardId, name: "Another todo", role: "todo" })
      .pipe(Effect.flip);
    assert.isTrue(isKanbanError(duplicate));
    assert.equal(duplicate.kind, "conflict");
    yield* kanban.columnCreate({ commandId: cmd(), boardId, name: "X" });
    const extra = yield* kanban.columnCreate({ commandId: cmd(), boardId, name: "Y" });
    const stolen = yield* kanban
      .columnUpdate({ commandId: cmd(), columnId: extra.columnId!, role: column("done").role })
      .pipe(Effect.flip);
    assert.equal(stolen.kind, "conflict");
    yield* kanban.columnUpdate({ commandId: cmd(), columnId: column("done").id, role: "none" });
    yield* kanban.columnUpdate({ commandId: cmd(), columnId: extra.columnId!, role: "done" });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("replays a command id without applying it twice", () =>
  Effect.gen(function* () {
    const { kanban, boardId } = yield* setup;
    const commandId = cmd();
    const first = yield* kanban.cardCreate({ commandId, boardId, title: "once" });
    const second = yield* kanban.cardCreate({ commandId, boardId, title: "once" });
    assert.deepEqual(second, first);
    const board = yield* snapshotBoard(kanban, boardId);
    assert.equal(board.cards.length, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps blocks and blockedBy symmetric", () =>
  Effect.gen(function* () {
    const { kanban, boardId } = yield* setup;
    const a = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "A" })).cardId!;
    const b = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "B" })).cardId!;
    yield* kanban.cardUpdate({ commandId: cmd(), cardId: a, blocks: [b] });
    let cards = (yield* snapshotBoard(kanban, boardId)).cards;
    assert.deepEqual(cards.find((c) => c.id === a)!.blocks, [b]);
    assert.deepEqual(cards.find((c) => c.id === b)!.blockedBy, [a]);
    yield* kanban.cardUpdate({ commandId: cmd(), cardId: b, blockedBy: [] });
    cards = (yield* snapshotBoard(kanban, boardId)).cards;
    assert.deepEqual(cards.find((c) => c.id === a)!.blocks, []);
    yield* kanban.cardUpdate({ commandId: cmd(), cardId: b, blockedBy: [a] });
    yield* kanban.cardDelete({ commandId: cmd(), cardId: a });
    cards = (yield* snapshotBoard(kanban, boardId)).cards;
    assert.deepEqual(cards.find((c) => c.id === b)!.blockedBy, []);
    const self = yield* kanban
      .cardUpdate({ commandId: cmd(), cardId: b, blocks: [b] })
      .pipe(Effect.flip);
    assert.equal(self.kind, "invalid");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("archives and unarchives with activity, and links a thread to one card", () =>
  Effect.gen(function* () {
    const { kanban, boardId } = yield* setup;
    const a = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "A" })).cardId!;
    const b = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "B" })).cardId!;
    yield* kanban.cardArchive({ commandId: cmd(), cardId: a });
    assert.deepEqual(
      (yield* snapshotBoard(kanban, boardId)).cards.map((c) => c.title),
      ["B"],
    );
    assert.equal((yield* kanban.listArchived({ boardId })).cards.length, 1);
    yield* kanban.cardUnarchive({ commandId: cmd(), cardId: a });
    assert.deepEqual(
      (yield* snapshotBoard(kanban, boardId)).cards.map((c) => c.title),
      ["B", "A"],
    );
    yield* kanban.cardComment({ commandId: cmd(), cardId: a, body: "hello", actor: "agent:t1" });

    const thread = ThreadId.make("thread-1");
    yield* kanban.cardLinkThread({ commandId: cmd(), cardId: a, threadId: thread });
    const conflict = yield* kanban
      .cardLinkThread({ commandId: cmd(), cardId: b, threadId: thread })
      .pipe(Effect.flip);
    assert.equal(conflict.kind, "conflict");
    const detail = yield* kanban.getCard({ cardId: a });
    assert.deepEqual(detail.card.linkedThreadIds, [thread]);
    assert.deepEqual(
      detail.activity.map((event) => event.kind),
      ["created", "archived", "unarchived", "comment", "linked"],
    );
    yield* kanban.cardUnlinkThread({ commandId: cmd(), cardId: a, threadId: thread });
    assert.deepEqual((yield* kanban.getCard({ cardId: a })).card.linkedThreadIds, []);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("subscribe emits a snapshot, then ordered deltas without gaps", () =>
  Effect.gen(function* () {
    const { kanban, boardId, column } = yield* setup;
    const received = yield* Queue.unbounded<KanbanStreamItem>();
    yield* kanban.subscribe().pipe(
      Stream.take(4),
      Stream.runForEach((item) => Queue.offer(received, item)),
      Effect.forkChild,
    );
    const snapshot = yield* Queue.take(received);
    assert.equal(snapshot.kind, "snapshot");
    assert.equal(snapshot.sequence, 1);

    const created = yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "A" });
    yield* kanban.cardMove({
      commandId: cmd(),
      cardId: created.cardId!,
      columnId: column("todo").id,
    });
    yield* kanban.cardArchive({ commandId: cmd(), cardId: created.cardId! });

    const deltas = [
      yield* Queue.take(received),
      yield* Queue.take(received),
      yield* Queue.take(received),
    ];
    assert.deepEqual(
      deltas.map((d) => [d.kind, d.sequence]),
      [
        ["card.upserted", 2],
        ["card.upserted", 3],
        ["card.removed", 4],
      ],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("checked moves into review need a finished checklist and a summary", () =>
  Effect.gen(function* () {
    const { kanban, boardId, column } = yield* setup;
    const created = yield* kanban.cardCreate({
      commandId: cmd(),
      boardId,
      title: "A",
      checklist: [
        { text: "one", done: true },
        { text: "two", done: false },
      ],
    });
    const cardId = created.cardId!;
    const review = column("review").id;
    const actor = "agent:thread-1" as const;

    const refused = yield* kanban.cardMoveChecked({
      commandId: cmd(),
      cardId,
      columnId: review,
      actor,
      summary: "Did it",
    });
    assert.deepEqual(refused, { refused: ["checklist item not done: two"] });
    const stuck = yield* kanban.getCard({ cardId });
    assert.equal(stuck.card.columnId, column("backlog").id);
    assert.deepEqual(
      stuck.activity.map((event) => event.kind),
      ["created", "dod-refused"],
    );

    // A user's plain move is not checked.
    yield* kanban.cardMove({ commandId: cmd(), cardId, columnId: review });
    yield* kanban.cardMove({ commandId: cmd(), cardId, columnId: column("todo").id });

    yield* kanban.cardUpdate({
      commandId: cmd(),
      cardId,
      checklist: stuck.card.checklist.map((item) => ({ ...item, done: true })),
    });
    const noSummary = yield* kanban.cardMoveChecked({
      commandId: cmd(),
      cardId,
      columnId: review,
      actor,
    });
    assert.deepEqual(noSummary, {
      refused: ["a completion summary (the `summary` field)"],
    });
    const moved = yield* kanban.cardMoveChecked({
      commandId: cmd(),
      cardId,
      columnId: review,
      actor,
      summary: "Did it",
    });
    assert.ok("moved" in moved);
    const done = yield* kanban.getCard({ cardId });
    assert.equal(done.card.columnId, review);
    assert.deepEqual(
      done.activity.filter((event) => event.kind === "comment").map((event) => event.payload),
      [{ body: "Did it" }],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("checked moves skip the check when the board turns the definition of done off", () =>
  Effect.gen(function* () {
    const { kanban, boardId, column } = yield* setup;
    yield* kanban.boardUpdate({
      commandId: cmd(),
      boardId,
      automations: { definitionOfDone: false },
    });
    const created = yield* kanban.cardCreate({
      commandId: cmd(),
      boardId,
      title: "A",
      checklist: [{ text: "one", done: false }],
    });
    const moved = yield* kanban.cardMoveChecked({
      commandId: cmd(),
      cardId: created.cardId!,
      columnId: column("done").id,
    });
    assert.ok("moved" in moved);
  }).pipe(Effect.provide(TestLayer)),
);

const seedThread = Effect.fn("seedThread")(function* (
  threadId: string,
  input: {
    readonly title: string;
    readonly pullRequests?: ReadonlyArray<unknown>;
    readonly turns: ReadonlyArray<{ readonly usage: unknown; readonly status?: string }>;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const json = (value: unknown) => JSON.stringify(value);
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
    thread_id: threadId,
    project_id: "p1",
    title: input.title,
    default_provider: "codex",
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    payload_json: json({
      title: input.title,
      branch: "feature/x",
      worktreePath: "/tmp/wt",
      pullRequests: input.pullRequests ?? [],
    }),
  })}`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
    run_id: `${threadId}-run`,
    thread_id: threadId,
    ordinal: 1,
    provider: "codex",
    status: "completed",
    requested_at: "2026-01-01T00:00:00.000Z",
    payload_json: json({
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:02:00.000Z",
      modelSelection: { instanceId: "codex", model: "test-model" },
    }),
  })}`;
  yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
    attempt_id: `${threadId}-attempt`,
    thread_id: threadId,
    run_id: `${threadId}-run`,
    attempt_ordinal: 1,
    root_node_id: "node",
    provider: "codex",
    provider_thread_id: `${threadId}-pt`,
    status: "completed",
    payload_json: "{}",
  })}`;
  for (const [index, turn] of input.turns.entries()) {
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
      provider_turn_id: `${threadId}-turn-${index}`,
      thread_id: threadId,
      provider_thread_id: `${threadId}-pt`,
      node_id: "node",
      run_attempt_id: `${threadId}-attempt`,
      ordinal: index + 1,
      status: turn.status ?? "completed",
      payload_json: json({
        // The context-window snapshot must not be mistaken for billed tokens.
        tokenUsage: { usedTokens: 999_999, updatedAt: "2026-01-01T00:00:00.000Z" },
        turnTokenUsage: turn.usage,
      }),
    })}`;
  }
});

const complete = {
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens: 1000,
  outputTokens: 500,
};
const rates = new Map([
  [
    "test-model",
    {
      inputCostPerToken: 1e-6,
      outputCostPerToken: 2e-6,
      cacheReadCostPerToken: 1e-7,
      cacheCreationCostPerToken: 1e-6,
      fast: null,
      ultrafast: null,
    },
  ],
]);
const layerWith = <A, E>(configuration: Layer.Layer<A, E>) =>
  Kanban.layer.pipe(
    Layer.provide(configuration),
    Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, NodeCrypto.layer)),
  );
const PricedLayer = layerWith(
  Layer.succeed(
    Kanban.KanbanPricing,
    Effect.succeed({ rates, overrides: new Map(), aliases: new Map() }),
  ),
);

it.effect("getCard derives thread info, tokens, cost and run time from the projection", () =>
  Effect.gen(function* () {
    const { kanban, boardId } = yield* setup;
    const created = yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "Ship" });
    const cardId = created.cardId!;
    yield* seedThread("t-1", {
      title: "Work on Ship",
      turns: [{ usage: complete }, { usage: complete }],
      pullRequests: [
        {
          host: "github.com",
          repository: "a/b",
          number: 7,
          url: "https://github.com/a/b/pull/7",
          source: "created",
          snapshot: { state: "merged" },
        },
      ],
    });
    yield* kanban.cardLinkThread({ commandId: cmd(), cardId, threadId: ThreadId.make("t-1") });
    yield* kanban.cardLinkThread({ commandId: cmd(), cardId, threadId: ThreadId.make("gone") });
    const detail = yield* kanban.getCard({ cardId });
    assert.deepEqual(
      detail.threads.find((thread) => thread.threadId === "t-1"),
      {
        threadId: ThreadId.make("t-1"),
        title: "Work on Ship",
        status: "completed",
        branch: "feature/x",
        worktreePath: "/tmp/wt",
        pullRequests: [{ url: "https://github.com/a/b/pull/7", number: 7, state: "merged" }],
      },
    );
    assert.strictEqual(detail.threads.find((thread) => thread.threadId === "gone")!.title, null);
    assert.strictEqual(detail.totalTokens, 3000);
    assert.closeTo(detail.costUsd!, 0.004, 1e-9);
    assert.strictEqual(detail.durationMs, 120_000);
  }).pipe(Effect.provide(PricedLayer)),
);

it.effect("getCard leaves cost unknown when a turn has no usage, and counts nothing unlinked", () =>
  Effect.gen(function* () {
    const { kanban, boardId } = yield* setup;
    const { cardId } = yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "A" });
    const empty = yield* kanban.getCard({ cardId: cardId! });
    assert.deepEqual([empty.costUsd, empty.totalTokens, empty.durationMs], [null, null, null]);
    yield* seedThread("t-2", { title: "T", turns: [{ usage: complete }, { usage: undefined }] });
    yield* kanban.cardLinkThread({
      commandId: cmd(),
      cardId: cardId!,
      threadId: ThreadId.make("t-2"),
    });
    const detail = yield* kanban.getCard({ cardId: cardId! });
    assert.strictEqual(detail.costUsd, null);
    assert.strictEqual(detail.totalTokens, 1500);
  }).pipe(Effect.provide(PricedLayer)),
);

it.effect("new boards start from the configured default template", () =>
  Effect.gen(function* () {
    const { board } = yield* setup;
    assert.deepEqual(
      board.columns.map((column) => [column.name, column.role, column.wipLimit]),
      [
        ["Ideas", "backlog", null],
        ["Shipping", "done", 3],
      ],
    );
    assert.deepEqual(
      board.templates.map((template) => template.name),
      ["Spike"],
    );
  }).pipe(
    Effect.provide(
      layerWith(
        Layer.succeed(
          Kanban.KanbanTemplateSource,
          Effect.succeed({
            columns: [
              { name: "Ideas", color: "slate", role: "backlog", wipLimit: null },
              { name: "Shipping", color: "green", role: "done", wipLimit: 3 },
            ],
            cardTemplates: [
              {
                name: "Spike",
                icon: "tag",
                color: "slate",
                priority: "low",
                checklist: [],
                acceptanceCriteria: [],
              },
            ],
          } as never),
        ),
      ),
    ),
  ),
);

it.effect("subtasks stay one level deep on the parent's board and can be detached", () =>
  Effect.gen(function* () {
    const { kanban, boardId } = yield* setup;
    const parent = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "P" })).cardId!;
    const child = (yield* kanban.cardCreate({
      commandId: cmd(),
      boardId,
      title: "C",
      parentCardId: parent,
    })).cardId!;
    assert.equal((yield* kanban.getCard({ cardId: child })).card.parentCardId, parent);

    const nested = yield* kanban
      .cardCreate({ commandId: cmd(), boardId, title: "G", parentCardId: child })
      .pipe(Effect.flip);
    assert.ok(isKanbanError(nested) && nested.kind === "invalid");
    const other = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "O" })).cardId!;
    const lonely = yield* kanban
      .cardUpdate({ commandId: cmd(), cardId: parent, parentCardId: other })
      .pipe(Effect.flip);
    assert.ok(isKanbanError(lonely), "a card with subtasks cannot become a subtask");

    // The reverse state: detach, then attach again.
    yield* kanban.cardUpdate({ commandId: cmd(), cardId: child, parentCardId: null });
    assert.equal((yield* kanban.getCard({ cardId: child })).card.parentCardId, null);
    yield* kanban.cardUpdate({ commandId: cmd(), cardId: child, parentCardId: parent });
    const family = (yield* kanban.cardFamily(parent))!;
    assert.deepEqual(
      family.subtasks.map((card) => card.id),
      [child],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("archiving a parent archives its subtasks and unarchiving restores only those", () =>
  Effect.gen(function* () {
    const { kanban, boardId } = yield* setup;
    const parent = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "P" })).cardId!;
    const mk = (title: string) =>
      kanban
        .cardCreate({ commandId: cmd(), boardId, title, parentCardId: parent })
        .pipe(Effect.map((r) => r.cardId!));
    const early = yield* mk("early");
    const kept = yield* mk("kept");
    yield* kanban.cardArchive({ commandId: cmd(), cardId: early });
    yield* kanban.cardArchive({ commandId: cmd(), cardId: parent });
    assert.deepEqual((yield* snapshotBoard(kanban, boardId)).cards, []);

    yield* kanban.cardUnarchive({ commandId: cmd(), cardId: parent });
    const board = yield* snapshotBoard(kanban, boardId);
    assert.deepEqual(board.cards.map((card) => card.id).toSorted(), [parent, kept].toSorted());
    assert.notEqual((yield* kanban.getCard({ cardId: early })).card.archivedAt, null);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("deleting a parent keeps its subtasks as ordinary cards", () =>
  Effect.gen(function* () {
    const { kanban, boardId } = yield* setup;
    const parent = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "P" })).cardId!;
    const child = (yield* kanban.cardCreate({
      commandId: cmd(),
      boardId,
      title: "C",
      parentCardId: parent,
    })).cardId!;
    yield* kanban.cardDelete({ commandId: cmd(), cardId: parent });
    assert.equal((yield* kanban.getCard({ cardId: child })).card.parentCardId, null);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("a parent's definition of done also needs every subtask done", () =>
  Effect.gen(function* () {
    const { kanban, boardId, column } = yield* setup;
    const parent = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "P" })).cardId!;
    const child = (yield* kanban.cardCreate({
      commandId: cmd(),
      boardId,
      title: "Wire it",
      parentCardId: parent,
    })).cardId!;
    const move = () =>
      kanban.cardMoveChecked({
        commandId: cmd(),
        cardId: parent,
        columnId: column("review").id,
        summary: "All done",
      });
    assert.deepEqual(yield* move(), { refused: ["subtask not done: #2 Wire it"] });
    yield* kanban.cardMove({ commandId: cmd(), cardId: child, columnId: column("done").id });
    assert.ok("moved" in (yield* move()));
  }).pipe(Effect.provide(TestLayer)),
);

const imagesLayer = (cleaned: string[]) =>
  Kanban.layer.pipe(
    Layer.provide(
      CardImages.layerLive.pipe(
        Layer.provide(
          Layer.succeed(ResourceCleanupService.ResourceCleanupService, {
            cleanupScheduledTasks: () => Effect.void,
            cleanupTerminals: () => Effect.void,
            cleanupPreviews: () => Effect.void,
            cleanupAttachments: (ids) => Effect.sync(() => void cleaned.push(...ids)),
          }),
        ),
      ),
    ),
    Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, NodeCrypto.layer)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kanban-images-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("card images are claimed to the card on save and cleaned up with it", () => {
  const cleaned: string[] = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const { kanban, boardId } = yield* setup;
    const pendingId = "pending-0b8e6a7e-1c1f-4c55-8d8e-0f6c0a1d2e3f";
    const foreignId = "thread-1-6d7c1d2e-3f4a-4b5c-8d9e-0a1b2c3d4e5f";
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    yield* fs.writeFile(`${attachmentsDir}/${pendingId}.png`, new Uint8Array([1, 2, 3]));
    const cardId = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "Shot" })).cardId!;
    yield* kanban.cardUpdate({
      commandId: cmd(),
      cardId,
      description: `![a](t3-attachment:${pendingId}) ![b](t3-attachment:${foreignId})`,
    });
    const { description } = (yield* kanban.getCard({ cardId })).card;
    const claimedId = /t3-attachment:(card-[a-z0-9-]+)\)/.exec(description)![1]!;
    assert.ok(claimedId.startsWith(`card-${cardId}-`));
    assert.ok(description.includes(foreignId));
    assert.deepEqual(
      Array.from(yield* fs.readFile(`${attachmentsDir}/${claimedId}.png`)),
      [1, 2, 3],
    );

    const missing = yield* kanban
      .cardUpdate({
        commandId: cmd(),
        cardId,
        description: "![c](t3-attachment:pending-7f2c1d2e-3f4a-4b5c-8d9e-0a1b2c3d4e5f)",
      })
      .pipe(Effect.flip);
    assert.equal(missing.kind, "invalid");

    yield* kanban.cardDelete({ commandId: cmd(), cardId });
    assert.deepEqual(cleaned, [claimedId]);
  }).pipe(Effect.provide(imagesLayer(cleaned)));
});

it.effect(
  "attachments are claimed, cover the card, and are cleaned up on remove and delete",
  () => {
    const cleaned: string[] = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const { kanban, boardId } = yield* setup;
      const pdf = "pending-1b8e6a7e-1c1f-4c55-8d8e-0f6c0a1d2e3f-pdf";
      const shot = "pending-2b8e6a7e-1c1f-4c55-8d8e-0f6c0a1d2e3f";
      const other = "pending-3b8e6a7e-1c1f-4c55-8d8e-0f6c0a1d2e3f";
      yield* fs.makeDirectory(attachmentsDir, { recursive: true });
      yield* fs.writeFile(`${attachmentsDir}/${pdf}.pdf`, new Uint8Array([9]));
      yield* fs.writeFile(`${attachmentsDir}/${shot}.png`, new Uint8Array([1, 2]));
      yield* fs.writeFile(`${attachmentsDir}/${other}.png`, new Uint8Array([3]));
      const cardId = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "Files" }))
        .cardId!;
      const add = (attachmentId: string, name: string, mimeType: string) =>
        kanban.cardUpdate({
          commandId: cmd(),
          cardId,
          addAttachments: [{ attachmentId, name, mimeType, sizeBytes: 2 }],
        });
      const read = () => kanban.getCard({ cardId }).pipe(Effect.map((result) => result.card));

      yield* add(pdf, "spec.pdf", "application/pdf");
      assert.equal((yield* read()).coverAttachmentId, null);
      yield* add(shot, "shot.png", "image/png");
      yield* add(other, "other.png", "image/png");
      const card = yield* read();
      const [specId, shotId, otherId] = card.attachments.map((a) => a.attachmentId);
      assert.deepEqual(
        card.attachments.map((a) => [a.name, a.addedBy]),
        [
          ["spec.pdf", "user"],
          ["shot.png", "user"],
          ["other.png", "user"],
        ],
      );
      assert.ok(shotId!.startsWith(`card-${cardId}-`));
      assert.deepEqual(Array.from(yield* fs.readFile(`${attachmentsDir}/${shotId}.png`)), [1, 2]);
      // The first image covers the card; later ones leave it alone.
      assert.equal(card.coverAttachmentId, shotId);

      const unknown = yield* kanban
        .cardUpdate({ commandId: cmd(), cardId, coverAttachmentId: "card-x-nope" })
        .pipe(Effect.flip);
      assert.equal(unknown.kind, "not_found");
      const notPending = yield* add(otherId!, "again.png", "image/png").pipe(Effect.flip);
      assert.equal(notPending.kind, "invalid");

      yield* kanban.cardUpdate({ commandId: cmd(), cardId, coverAttachmentId: otherId! });
      assert.equal((yield* read()).coverAttachmentId, otherId);
      yield* kanban.cardUpdate({ commandId: cmd(), cardId, removeAttachmentIds: [otherId!] });
      const afterRemove = yield* read();
      assert.equal(afterRemove.coverAttachmentId, null);
      assert.deepEqual(
        afterRemove.attachments.map((a) => a.attachmentId),
        [specId, shotId],
      );
      assert.deepEqual(cleaned, [otherId]);

      yield* kanban.cardUpdate({ commandId: cmd(), cardId, coverAttachmentId: shotId! });
      yield* kanban.cardUpdate({ commandId: cmd(), cardId, coverAttachmentId: null });
      assert.equal((yield* read()).coverAttachmentId, null);

      yield* kanban.cardDelete({ commandId: cmd(), cardId });
      assert.deepEqual(cleaned, [otherId, specId, shotId]);
    }).pipe(Effect.provide(imagesLayer(cleaned)));
  },
);
