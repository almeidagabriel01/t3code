import { assert, describe, it } from "@effect/vitest";
import type {
  KanbanBoardSnapshot,
  KanbanCard,
  KanbanColumn,
  KanbanStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  applyKanbanStreamItem,
  EMPTY_KANBAN_STATE,
  kanbanStateStream,
  selectKanbanColumns,
  type KanbanState,
} from "./kanban.ts";

const column = (id: string, orderKey: string): KanbanColumn =>
  ({
    id,
    boardId: "b1",
    name: id,
    color: "slate",
    orderKey,
    wipLimit: null,
    role: "none",
  }) as never;
const card = (id: string, columnId: string, orderKey: string): KanbanCard =>
  ({ id, boardId: "b1", columnId, orderKey, title: id }) as never;
const board = (cards: ReadonlyArray<KanbanCard> = []): KanbanBoardSnapshot =>
  ({
    id: "b1",
    projectId: "p1",
    title: "Board",
    columns: [column("c1", "a"), column("c2", "m")],
    labels: [],
    templates: [],
    cards,
  }) as never;

const snapshot = (sequence: number, cards: ReadonlyArray<KanbanCard> = []): KanbanStreamItem => ({
  kind: "snapshot",
  sequence,
  boards: [board(cards)],
});

const apply = (state: KanbanState, item: KanbanStreamItem) => {
  const result = applyKanbanStreamItem(state, item);
  assert.equal(result._tag, "applied");
  return (result as { state: KanbanState }).state;
};

describe("applyKanbanStreamItem", () => {
  it("replaces state from a snapshot and applies contiguous deltas", () => {
    let state = apply(EMPTY_KANBAN_STATE, snapshot(4, [card("k1", "c1", "m")]));
    state = apply(state, { kind: "card.upserted", sequence: 5, card: card("k2", "c1", "a") });
    state = apply(state, { kind: "card.upserted", sequence: 6, card: card("k1", "c2", "m") });
    assert.equal(state.sequence, 6);
    assert.deepEqual(
      selectKanbanColumns(state.boards.get("b1" as never)!).map(({ column, cards }) => [
        column.id,
        cards.map((c) => c.id),
      ]),
      [
        ["c1", ["k2"]],
        ["c2", ["k1"]],
      ],
    );
    state = apply(state, {
      kind: "card.removed",
      sequence: 7,
      boardId: "b1" as never,
      cardId: "k2" as never,
    });
    state = apply(state, { kind: "column.upserted", sequence: 8, column: column("c0", "0") });
    state = apply(state, {
      kind: "column.removed",
      sequence: 9,
      boardId: "b1" as never,
      columnId: "c2" as never,
    });
    assert.deepEqual(
      state.boards.get("b1" as never)!.columns.map((c) => c.id),
      ["c0", "c1"],
    );
    state = apply(state, { kind: "board.removed", sequence: 10, boardId: "b1" as never });
    assert.equal(state.boards.size, 0);
  });

  it("ignores stale deltas and reports a gap for skipped or orphaned ones", () => {
    const state = apply(EMPTY_KANBAN_STATE, snapshot(4));
    const stale = applyKanbanStreamItem(state, {
      kind: "card.upserted",
      sequence: 4,
      card: card("k1", "c1", "m"),
    });
    assert.deepEqual(stale, { _tag: "applied", state });
    for (const item of [
      { kind: "card.upserted", sequence: 6, card: card("k1", "c1", "m") },
      {
        kind: "card.removed",
        sequence: 5,
        boardId: "missing" as never,
        cardId: "k1" as never,
      },
    ] satisfies KanbanStreamItem[]) {
      assert.deepEqual(applyKanbanStreamItem(state, item), { _tag: "gap" });
    }
    assert.deepEqual(
      applyKanbanStreamItem(EMPTY_KANBAN_STATE, {
        kind: "board.removed",
        sequence: 1,
        boardId: "b1" as never,
      }),
      { _tag: "gap" },
    );
  });
});

describe("kanbanStateStream", () => {
  it.effect("resubscribes after a gap and continues from the fresh snapshot", () =>
    Effect.gen(function* () {
      const streams: ReadonlyArray<ReadonlyArray<KanbanStreamItem>> = [
        [
          snapshot(1),
          { kind: "card.upserted", sequence: 3, card: card("lost", "c1", "m") },
          { kind: "card.upserted", sequence: 4, card: card("never-applied", "c1", "n") },
        ],
        [
          snapshot(9, [card("k1", "c1", "m")]),
          { kind: "card.removed", sequence: 10, boardId: "b1" as never, cardId: "k1" as never },
        ],
      ];
      let opened = 0;
      const states = yield* kanbanStateStream(() => Stream.fromIterable(streams[opened++]!)).pipe(
        Stream.runCollect,
      );
      assert.equal(opened, 2);
      assert.deepEqual(
        states.map((state) => [state.sequence, state.boards.get("b1" as never)!.cards.size]),
        [
          [1, 0],
          [9, 1],
          [10, 0],
        ],
      );
    }),
  );
});
