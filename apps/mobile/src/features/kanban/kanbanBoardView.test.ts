import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import { boardScopeKey } from "@t3tools/client-runtime/state/kanbanLogic";
import type { EnvironmentId, KanbanCard, KanbanColumn } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ALL_PROJECTS, buildBoardColumns } from "./kanbanBoardView";

const column = (id: string, role: KanbanColumn["role"], orderKey: string) =>
  ({ id, boardId: "b1", name: id, color: "blue", orderKey, wipLimit: null, role }) as KanbanColumn;
const card = (id: string, columnId: string, orderKey: string) =>
  ({ id, boardId: "b1", columnId, orderKey, number: 1, title: id }) as KanbanCard;

const board = {
  id: "b1",
  projectId: "p1",
  columns: [column("todo", "todo", "a"), column("wip", "in-progress", "b")],
  cards: new Map([
    ["c2", card("c2", "todo", "b")],
    ["c1", card("c1", "todo", "a")],
  ]),
} as unknown as KanbanBoardState;
const environmentId = "env" as EnvironmentId;
const boards = [{ environmentId, board }];

describe("buildBoardColumns", () => {
  it("lists one board's columns with ordered cards and a quick-add target", () => {
    const columns = buildBoardColumns(boards, boardScopeKey(environmentId, board.projectId));
    expect(columns.map((entry) => [entry.key, entry.cards.map((item) => item.card.id)])).toEqual([
      ["todo", ["c1", "c2"]],
      ["wip", []],
    ]);
    expect(columns[0]?.addTo?.columnId).toBe("todo");
  });

  it("merges every board by role without a quick-add target", () => {
    const columns = buildBoardColumns(boards, ALL_PROJECTS);
    expect(columns.find((entry) => entry.key === "todo")?.cards).toHaveLength(2);
    expect(columns.every((entry) => entry.addTo === null)).toBe(true);
  });

  it("is empty for a board that is gone", () => {
    expect(buildBoardColumns(boards, "other")).toEqual([]);
  });
});
