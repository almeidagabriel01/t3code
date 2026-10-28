import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
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
