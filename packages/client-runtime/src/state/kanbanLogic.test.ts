import type { KanbanBoardState } from "./kanban.ts";
import type {
  EnvironmentId,
  KanbanBoardId,
  KanbanCard,
  KanbanCardId,
  KanbanColumn,
  KanbanColumnId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyMoveLocally,
  checklistProgress,
  collectGlobalBoards,
  collectGlobalCards,
  definitionOfDoneWarning,
  formatCardDuration,
  describeCardEvent,
  dueAtToInput,
  inputToDueAt,
  moveChecklistItem,
  validateDefaultTemplate,
  dropToMove,
  EMPTY_FILTERS,
  filterGlobalCards,
  findCardInBoards,
  groupCardsByProject,
  groupCardsByRole,
  isOverdue,
  isWipExceeded,
  kanbanCardContextRecord,
  kanbanCardRecordForThread,
  withKanbanCardContext,
  shouldDeliverKanbanCard,
  subtaskTileInfo,
} from "./kanbanLogic.ts";

const cardId = (id: string) => id as KanbanCardId;
const columnId = (id: string) => id as KanbanColumnId;

function column(id: string, role: KanbanColumn["role"], wipLimit: number | null = null) {
  return {
    id: columnId(id),
    boardId: "b1" as KanbanBoardId,
    name: id,
    color: "",
    orderKey: id,
    wipLimit,
    role,
  } as KanbanColumn;
}

function card(id: string, columnIdValue: string, extra: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: cardId(id),
    boardId: "b1" as KanbanBoardId,
    columnId: columnId(columnIdValue),
    orderKey: id,
    number: Number(id.replace(/\D/g, "")) || 1,
    title: `Card ${id}`,
    description: "",
    type: null,
    priority: "none",
    labelIds: [],
    dueAt: null,
    estimate: null,
    checklist: [],
    acceptanceCriteria: [],
    blocks: [],
    blockedBy: [],
    linkedThreadIds: [],
    parentCardId: null,
    attachments: [],
    coverAttachmentId: null,
    archivedAt: null,
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  } as KanbanCard;
}

function board(projectId: string, boardId: string, cards: KanbanCard[]): KanbanBoardState {
  return {
    id: boardId as KanbanBoardId,
    projectId: projectId as ProjectId,
    title: projectId,
    columns: [column("todo", "todo"), column("custom", "none")],
    labels: [{ id: "l1" as never, name: "Urgent fix", color: "red" }],
    templates: [{ id: "bug" as never, name: "Bug" } as never],
    automations: {
      threadStarted: true,
      runCompleted: true,
      prMerged: true,
      definitionOfDone: true,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cards: new Map(cards.map((entry) => [entry.id, entry])),
  } as KanbanBoardState;
}

const columns = [
  { columnId: columnId("a"), cardIds: [cardId("1"), cardId("2"), cardId("3")] },
  { columnId: columnId("b"), cardIds: [cardId("4")] },
  { columnId: columnId("c"), cardIds: [] },
];

describe("dropToMove", () => {
  it("places before the target when moving up and after it when moving down", () => {
    expect(dropToMove(cardId("3"), "1", columns)).toEqual({
      cardId: "3",
      columnId: "a",
      beforeCardId: "1",
    });
    expect(dropToMove(cardId("1"), "3", columns)).toEqual({
      cardId: "1",
      columnId: "a",
      afterCardId: "3",
    });
  });

  it("takes the target's place in another column", () => {
    expect(dropToMove(cardId("2"), "4", columns)).toEqual({
      cardId: "2",
      columnId: "b",
      beforeCardId: "4",
    });
  });

  it("appends when dropped on a column, and ignores a no-op", () => {
    expect(dropToMove(cardId("2"), "b", columns)).toEqual({
      cardId: "2",
      columnId: "b",
      afterCardId: "4",
    });
    expect(dropToMove(cardId("2"), "c", columns)).toEqual({ cardId: "2", columnId: "c" });
    expect(dropToMove(cardId("2"), "2", columns)).toBeNull();
  });
});

describe("applyMoveLocally", () => {
  it("mirrors what the server does", () => {
    const moved = applyMoveLocally(columns, {
      cardId: cardId("1"),
      columnId: columnId("b"),
      beforeCardId: cardId("4"),
    });
    expect(moved.map((entry) => entry.cardIds)).toEqual([["2", "3"], ["1", "4"], []]);
    const down = applyMoveLocally(columns, {
      cardId: cardId("1"),
      columnId: columnId("a"),
      afterCardId: cardId("2"),
    });
    expect(down[0]!.cardIds).toEqual(["2", "1", "3"]);
  });
});

describe("definition of done", () => {
  const target = column("review", "review");
  const open = card("1", "todo", {
    checklist: [
      { id: "i1" as never, text: "a", done: true },
      { id: "i2" as never, text: "b", done: false },
    ],
  });

  it("warns for review and done only while items are open", () => {
    const b = board("p", "b1", []);
    expect(definitionOfDoneWarning(b, open, target)).toContain("1 checklist item");
    expect(definitionOfDoneWarning(b, open, column("x", "todo"))).toBeNull();
    expect(
      definitionOfDoneWarning(
        { automations: { ...b.automations, definitionOfDone: false } },
        open,
        target,
      ),
    ).toBeNull();
  });

  it("counts checklist progress and WIP", () => {
    expect(checklistProgress(open.checklist)).toEqual({ done: 1, total: 2 });
    expect(isWipExceeded(column("x", "none", 2), 3)).toBe(true);
    expect(isWipExceeded(column("x", "none", null), 99)).toBe(false);
  });
});

describe("global aggregation", () => {
  const env1 = "e1" as EnvironmentId;
  const env2 = "e2" as EnvironmentId;
  const state = (boards: KanbanBoardState[]) => ({
    sequence: 1,
    boards: new Map(boards.map((entry) => [entry.id, entry])),
  });
  const boards = collectGlobalBoards([
    {
      environmentId: env1,
      state: state([
        board("p1", "b1", [
          card("1", "todo", { priority: "high", labelIds: ["l1" as never], type: "bug" as never }),
          card("2", "custom", { linkedThreadIds: ["t1" as ThreadId] }),
        ]),
      ]),
    },
    {
      environmentId: env2,
      state: state([board("p2", "b2", [card("3", "todo", { title: "Login bug" })])]),
    },
    { environmentId: env2, state: null },
  ]);
  const cards = collectGlobalCards(boards);

  it("tags every card with its environment, project and column role", () => {
    expect(cards.map((entry) => [entry.environmentId, entry.projectId, entry.role])).toEqual([
      ["e1", "p1", "todo"],
      ["e1", "p1", "none"],
      ["e2", "p2", "todo"],
    ]);
  });

  it("filters on every dimension", () => {
    const only = (filters: Partial<typeof EMPTY_FILTERS>) =>
      filterGlobalCards(cards, boards, { ...EMPTY_FILTERS, ...filters }).map((e) => e.card.id);
    expect(only({ projects: ["e2:p2"] })).toEqual(["3"]);
    expect(only({ priority: "high" })).toEqual(["1"]);
    expect(only({ label: "urgent fix" })).toEqual(["1"]);
    expect(only({ type: "Bug" })).toEqual(["1"]);
    expect(only({ hasAgent: true })).toEqual(["2"]);
    expect(only({ text: "login" })).toEqual(["3"]);
  });

  it("hides subtasks on request", () => {
    const withSubtask = collectGlobalBoards([
      {
        environmentId: env1,
        state: state([
          board("p1", "b1", [card("1", "todo"), card("2", "todo", { parentCardId: cardId("1") })]),
        ]),
      },
    ]);
    const shown = (hideSubtasks: boolean) =>
      filterGlobalCards(collectGlobalCards(withSubtask), withSubtask, {
        ...EMPTY_FILTERS,
        hideSubtasks,
      }).map((e) => e.card.id);
    expect(shown(false)).toEqual(["1", "2"]);
    expect(shown(true)).toEqual(["1"]);
  });

  it("finds a card on any board", () => {
    expect(findCardInBoards(boards, cardId("3"))?.environmentId).toBe("e2");
    expect(findCardInBoards(boards, cardId("nope"))).toBeNull();
  });

  it("merges by role with role-less cards in a trailing column and lanes per project", () => {
    expect(groupCardsByRole(cards).map((entry) => [entry.role, entry.cards.length])).toEqual([
      ["backlog", 0],
      ["todo", 2],
      ["in-progress", 0],
      ["review", 0],
      ["done", 0],
      ["none", 1],
    ]);
    expect(groupCardsByRole(cards.filter((e) => e.role !== "none")).at(-1)?.role).toBe("done");
    expect(groupCardsByProject(boards, cards).map((lane) => [lane.key, lane.cards.length])).toEqual(
      [
        ["e1:p1", 2],
        ["e2:p2", 1],
      ],
    );
  });
});

describe("kanbanCardContextRecord", () => {
  it("clamps to the context schema bounds", () => {
    const b = board("p", "b1", []);
    const record = kanbanCardContextRecord(
      card("7", "todo", {
        description: "x".repeat(20_000),
        labelIds: ["l1" as never],
        type: "bug" as never,
      }),
      b,
    );
    expect(record.description).toHaveLength(16_000);
    // A pair straddling the bound is dropped whole, never left as a lone surrogate.
    const emoji = "x".repeat(15_999) + "😀tail";
    const cut = kanbanCardContextRecord(card("7", "todo", { description: emoji }), b);
    expect(cut.description).toBe("x".repeat(15_999));
    const fits = kanbanCardContextRecord(
      card("7", "todo", { description: "x".repeat(15_998) + "😀" }),
      b,
    );
    expect(fits.description.endsWith("😀")).toBe(true);
    const item = { id: "i" as never, text: "y".repeat(2_047) + "😀", done: false };
    expect(
      kanbanCardContextRecord(card("7", "todo", { checklist: [item] }), b).checklist[0]!.text,
    ).toBe("y".repeat(2_047));
    expect(record.labels).toEqual(["Urgent fix"]);
    expect(record.type).toBe("Bug");
    expect(record.contextId).toBe("kanban-card-7");
  });
});

describe("card helpers", () => {
  it("round-trips the due date through the date input", () => {
    expect(dueAtToInput(inputToDueAt("2026-03-09"))).toBe("2026-03-09");
    expect(inputToDueAt("")).toBeNull();
    expect(dueAtToInput(null)).toBe("");
  });

  it("reorders checklist items within bounds", () => {
    expect(moveChecklistItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveChecklistItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("describes events", () => {
    const name = (id: string) => `col ${id}`;
    expect(describeCardEvent({ kind: "moved", payload: { toColumnId: "x" } }, name)).toBe(
      "Moved to col x",
    );
    expect(describeCardEvent({ kind: "comment", payload: { body: "hi" } }, name)).toBe("hi");
    expect(
      describeCardEvent({ kind: "dod-refused", payload: { missing: ["a", "b"] } }, name),
    ).toContain("a, b");
  });
});

describe("validateDefaultTemplate", () => {
  const column = (name: string, role: KanbanColumn["role"]) => ({
    name,
    color: "slate",
    role,
    wipLimit: null,
  });
  it("accepts one column per role and any number without one", () => {
    expect(
      validateDefaultTemplate({
        columns: [column("A", "backlog"), column("B", "none"), column("C", "none")],
        cardTemplates: [],
      }),
    ).toBeNull();
  });
  it("rejects no columns, blank names and a repeated role", () => {
    expect(validateDefaultTemplate({ columns: [], cardTemplates: [] })).toMatch(/at least one/);
    expect(validateDefaultTemplate({ columns: [column(" ", "none")], cardTemplates: [] })).toMatch(
      /name/,
    );
    expect(
      validateDefaultTemplate({
        columns: [column("A", "done"), column("B", "done")],
        cardTemplates: [],
      }),
    ).toMatch(/Only one column.*Done/);
  });
});

describe("formatCardDuration", () => {
  it("does not round short runs up to a minute", () => {
    expect(formatCardDuration(5_000)).toBe("<1 min");
    expect(formatCardDuration(59_999)).toBe("<1 min");
    expect(formatCardDuration(60_000)).toBe("1 min");
    expect(formatCardDuration(150_000)).toBe("3 min");
  });
});

describe("shouldDeliverKanbanCard", () => {
  const withCard = (cardId: string) => ({
    context: { records: [{ kind: "kanban-card", cardId }] },
  });
  it("delivers until a message carries that card", () => {
    expect(shouldDeliverKanbanCard("c1", [])).toBe(true);
    expect(
      shouldDeliverKanbanCard("c1", [{}, { context: { records: [{ kind: "mention" }] } }]),
    ).toBe(true);
    expect(shouldDeliverKanbanCard("c1", [withCard("c2")])).toBe(true);
    expect(shouldDeliverKanbanCard("c1", [{}, withCard("c1")])).toBe(false);
  });
});

describe("subtask tiles", () => {
  it("counts live subtasks in done columns and names the parent", () => {
    const cards = new Map(
      [
        card("1", "todo"),
        card("2", "done", { parentCardId: cardId("1") }),
        card("3", "todo", { parentCardId: cardId("1") }),
      ].map((entry) => [entry.id, entry]),
    );
    const info = subtaskTileInfo({
      cards,
      columns: [column("todo", "todo"), column("done", "done")],
    });
    expect(info(cards.get(cardId("1"))!)).toEqual({ subtasksDone: 1, subtasksTotal: 2 });
    expect(info(cards.get(cardId("3"))!)).toEqual({ parentNumber: 1, parentTitle: "Card 1" });
  });
});

describe("input edges", () => {
  it("refuses a due date the calendar does not have instead of rolling it over", () => {
    for (const value of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-04-31", "26-01-01"]) {
      expect(inputToDueAt(value), value).toBeNull();
    }
    expect(dueAtToInput(inputToDueAt("2028-02-29"))).toBe("2028-02-29");
  });

  it("is overdue only strictly after the due instant", () => {
    const dueAt = "2026-03-09T12:00:00.000Z";
    const now = Date.parse(dueAt);
    expect(isOverdue({ dueAt }, now)).toBe(false);
    expect(isOverdue({ dueAt }, now + 1)).toBe(true);
    expect(isOverdue({ dueAt: null }, now)).toBe(false);
  });

  it("ignores drops that name nothing, and appends to an empty target", () => {
    expect(dropToMove(cardId("missing"), "b", columns)).toBeNull();
    expect(dropToMove(cardId("1"), "nowhere", columns)).toBeNull();
    expect(dropToMove(cardId("4"), "b", columns)).toBeNull();
    const moved = applyMoveLocally(columns, { cardId: cardId("1"), columnId: columnId("c") });
    expect(moved.map((entry) => entry.cardIds)).toEqual([["2", "3"], ["4"], ["1"]]);
    // An anchor that is gone appends instead of dropping the card.
    const stale = applyMoveLocally(columns, {
      cardId: cardId("1"),
      columnId: columnId("b"),
      beforeCardId: cardId("gone"),
    });
    expect(stale[1]!.cardIds).toEqual(["4", "1"]);
  });
});

describe("a card's context on a thread", () => {
  const linked = card("7", "todo", { linkedThreadIds: ["thread-7" as ThreadId] });
  const state = (cards: KanbanCard[]) => ({
    sequence: 1,
    boards: new Map([["b1" as KanbanBoardId, board("p1", "b1", cards)]]),
  });

  it("finds the live card a thread is linked to and nothing else", () => {
    expect(kanbanCardRecordForThread(state([linked]), "thread-7")).toMatchObject({
      kind: "kanban-card",
      cardId: "7",
    });
    expect(kanbanCardRecordForThread(state([linked]), "thread-8")).toBeUndefined();
    expect(kanbanCardRecordForThread(null, "thread-7")).toBeUndefined();
    const archived = { ...linked, archivedAt: "2026-02-01T00:00:00.000Z" } as KanbanCard;
    expect(kanbanCardRecordForThread(state([archived]), "thread-7")).toBeUndefined();
  });

  it("adds the record and a reference to a message without losing what it carried", () => {
    const record = kanbanCardRecordForThread(state([linked]), "thread-7")!;
    const plain = withKanbanCardContext({ text: "Go", context: undefined }, record);
    expect(plain.text.startsWith("Go\n\n")).toBe(true);
    expect(plain.context).toMatchObject({ version: 1, records: [record] });
    const other = { kind: "mention" } as never;
    const both = withKanbanCardContext(
      { text: "Go", context: { version: 1, records: [other] } },
      record,
    );
    expect(both.context.records).toEqual([other, record]);
  });
});
