import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  type KanbanBoardId,
  type KanbanCardId,
  type NoteDocument,
  type ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NoteStartWorkDialog } from "./NoteStartWorkDialog";

const environmentId = EnvironmentId.make("env");
const boardId = "board-1" as KanbanBoardId;
const cardId = "card-7" as KanbanCardId;

const mocks = vi.hoisted(() => ({ startWork: vi.fn() }));

vi.mock("./useNoteCommand", () => ({ useNoteCommand: () => mocks.startWork }));
vi.mock("../../state/notes", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { notesEnvironment: { startWork: { permissionAtom: () => allowed } } };
});
vi.mock("../../state/entities", () => ({
  useProjects: () =>
    [
      {
        environmentId: "env",
        id: "web",
        title: "Web",
        workspaceRoot: "/code/web",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        environmentId: "env",
        id: "api",
        title: "API",
        workspaceRoot: "/code/api",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ] as unknown as EnvironmentProject[],
  useQuietThreadShells: () => [],
}));
vi.mock("../../state/kanban", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const card = {
    id: "card-7",
    boardId: "board-1",
    columnId: "backlog",
    number: 7,
    title: "Wire the header",
    archivedAt: null,
  };
  const board = {
    id: "board-1",
    projectId: "web",
    columns: [{ id: "backlog", name: "Backlog" }],
    cards: new Map([["card-7", card]]),
  };
  const live = Atom.make(
    AsyncResult.success({ sequence: 1, boards: new Map([["board-1", board]]) }),
  );
  return {
    kanbanEnvironment: { live: () => live },
    useKanbanEnvironmentIds: () => ["env"],
  };
});
vi.mock("../../hooks/useSidebarProjectGroups", () => ({ useSidebarProjectGroups: () => [] }));
vi.mock("../kanban/KanbanStartAgent", () => ({ KanbanStartAgentDialog: () => null }));

const note: NoteDocument = {
  id: null,
  path: "web/Header.md",
  folder: "web",
  title: "Header",
  body: "# Header\n",
  pinned: false,
  preview: "",
  related: [],
  card: null,
  updatedBy: "user",
  revision: "a".repeat(64),
  updatedAt: "2026-01-01T00:00:00.000Z",
  size: 9,
};

function setup() {
  mocks.startWork
    .mockReset()
    .mockResolvedValueOnce({ ok: false, error: new Error("Disconnected") })
    .mockResolvedValueOnce({
      ok: true,
      value: {
        note: { ...note, card: { cardId, projectId: "web" as ProjectId } },
        boardId,
        cardId,
      },
    });
}

describe("NoteStartWorkDialog", () => {
  it("retries with the same request id and then shows the card it created", async () => {
    setup();
    const onStarted = vi.fn();
    await using _screen = await render(
      <NoteStartWorkDialog
        environmentId={environmentId}
        document={note}
        onStarted={onStarted}
        onClose={vi.fn()}
      />,
    );
    // The note's folder names the project.
    await expect.element(page.getByRole("combobox", { name: "Project" })).toHaveTextContent("Web");

    await userEvent.click(page.getByRole("button", { name: "Start work" }));
    await expect.element(page.getByRole("alert")).toHaveTextContent("Disconnected");
    await userEvent.click(page.getByRole("button", { name: "Try again" }));

    await expect.element(page.getByText("Card created")).toBeVisible();
    await expect.element(page.getByText("Wire the header")).toBeVisible();
    await expect.element(page.getByText("#7")).toBeVisible();
    expect(mocks.startWork).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.startWork.mock.calls.map(([call]) => call.input);
    expect(first).toEqual({ path: note.path, projectId: "web", requestId: first.requestId });
    expect(second.requestId).toBe(first.requestId);
    expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({ card: { cardId, projectId: "web" } }),
    );
  });
});
