import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import { boardScopeKey } from "@t3tools/client-runtime/state/kanbanLogic";
import type { EnvironmentId, KanbanCard, KanbanColumn, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_PROJECTS,
  buildBoardColumns,
  newBoardTargets,
  projectLabelsByScope,
} from "./kanbanBoardView";

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

describe("newBoardTargets", () => {
  const project = (id: string, title: string, workspaceRoot: string) => ({
    environmentId,
    id: id as ProjectId,
    title,
    workspaceRoot,
  });
  const projects = [
    project("p1", "Alpha", "/work/alpha"),
    project("p2", "Beta", "/work/beta"),
    project("s1", "No project", "/data/scratch"),
  ];
  const targets = (scratchWorkspaceRoot: string | null, withBoards = boards) =>
    newBoardTargets({
      environments: [{ environmentId, scratchWorkspaceRoot }],
      projects,
      boards: withBoards,
    }).map((target) => [target.title, target.projectId]);

  it("lists No project first, then projects without a board", () => {
    expect(targets("/data/scratch")).toEqual([
      ["No project", null],
      ["Beta", "p2"],
    ]);
  });

  it("drops No project when its board exists or the server offers no such folder", () => {
    const scratchBoard = { environmentId, board: { ...board, id: "b2", projectId: "s1" } };
    expect(targets("/data/scratch", [...boards, scratchBoard] as never)).toEqual([["Beta", "p2"]]);
    expect(targets(null)).toEqual([
      ["Beta", "p2"],
      ["No project", "s1"],
    ]);
  });

  it("tells same-titled projects apart and keeps Scratch out of the labels", () => {
    const twins = [
      project("a", "server", "/code/t3code/apps/server"),
      project("b", "server", "/code/other-repo/server"),
      project("s1", "No project", "/data/scratch"),
    ];
    const environments = [{ environmentId, scratchWorkspaceRoot: "/data/scratch" }];
    expect(
      newBoardTargets({ environments, projects: twins, boards: [] }).map((target) => target.title),
    ).toEqual(["No project", "server · apps", "server · other-repo"]);
    expect([...projectLabelsByScope({ environments, projects: twins }).values()]).toEqual([
      "server · apps",
      "server · other-repo",
    ]);
  });
});
