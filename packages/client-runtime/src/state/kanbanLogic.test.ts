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
  isWipExceeded,
  kanbanCardContextRecord,
  shouldDeliverKanbanCard,
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
