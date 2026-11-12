import type { EnvironmentId, KanbanCard } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    canEdit: true,
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
    updateCard: vi.fn(),
    moveCard: vi.fn(),
    archiveCard: vi.fn(),
    deleteCard: vi.fn(),
  },
}));

vi.mock("../../components/ui/Dialog", () => ({
  alert: mocks.alert,
  prompt: mocks.prompt,
  confirm: mocks.confirm,
}));
vi.mock("../../components/ui/Menu", () => {
  type Action = { id: string; title: string; subactions?: Action[] };
  const flat = (actions: ReadonlyArray<Action>): Action[] =>
    actions.flatMap((action) => (action.subactions ? flat(action.subactions) : [action]));
  return {
    Menu: (props: {
      actions: ReadonlyArray<Action>;
      onPressAction: (event: { nativeEvent: { event: string } }) => void;
      shouldOpenOnLongPress?: boolean;
      children?: ReactNode;
    }) => (
      <div data-long-press={String(props.shouldOpenOnLongPress)}>
        {props.children}
        {flat(props.actions).map((action) => (
          <button
            key={action.id}
            onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
          >
            {action.id}
          </button>
        ))}
      </div>
    ),
  };
});
vi.mock("./useKanbanActions", () => ({
  useKanbanActions: () => ({
    canEdit: mocks.canEdit,
    updateCard: mocks.updateCard,
    moveCard: mocks.moveCard,
    archiveCard: mocks.archiveCard,
    deleteCard: mocks.deleteCard,
  }),
}));

import { KanbanCardMenu, kanbanCardMenuActions, promptDueDate } from "./KanbanCardMenu";

const board = {
  columns: [
    { id: "todo", name: "To do", role: "backlog", definitionOfDone: [] },
    { id: "done", name: "Done", role: "done", definitionOfDone: ["Tested"] },
  ],
  labels: [
    { id: "bug", name: "Bug", color: "red" },
    { id: "ui", name: "UI", color: "blue" },
  ],
  templates: [],
  automations: { definitionOfDone: true },
  cards: new Map(),
} as never;
const card = {
  id: "c1",
  number: 7,
  title: "Fix it",
  columnId: "todo",
  labelIds: ["bug"],
  dueAt: null,
  checklist: [{ id: "i", text: "x", done: false }],
} as unknown as KanbanCard;

let root: Root;
let host: HTMLElement;
const onOpen = vi.fn();
const render = (openOnPress?: boolean) =>
  act(() =>
    root.render(
      <KanbanCardMenu
        environmentId={"env" as EnvironmentId}
        board={board}
        card={card}
        onOpen={onOpen}
        openOnPress={openOnPress}
      >
        <span>tile</span>
      </KanbanCardMenu>,
    ),
  );
const press = (id: string) =>
  act(async () => {
    const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === id);
    if (!button) throw new Error(`Missing ${id}`);
    button.click();
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = window.document.createElement("div");
  root = createRoot(host);
  mocks.canEdit = true;
  for (const mock of [mocks.prompt, mocks.confirm, mocks.alert, onOpen]) mock.mockReset();
  mocks.updateCard.mockReset().mockResolvedValue(true);
  mocks.moveCard.mockReset().mockResolvedValue(true);
  mocks.archiveCard.mockReset().mockResolvedValue(true);
  mocks.deleteCard.mockReset().mockResolvedValue(true);
});
afterEach(() => act(() => root.unmount()));

describe("kanbanCardMenuActions", () => {
  it("offers the other columns and the board labels with their checked state", () => {
    const actions = kanbanCardMenuActions(board, card);
    expect(actions.map((a) => a.id)).toEqual([
      "open",
      "rename",
      "move",
      "labels",
      "due",
      "archive",
      "delete",
    ]);
    expect(actions.find((a) => a.id === "move")?.subactions?.map((a) => a.id)).toEqual([
      "move:done",
    ]);
    expect(actions.find((a) => a.id === "labels")?.subactions?.map((a) => a.state)).toEqual([
      "on",
      "off",
    ]);
    expect(new Set(actions.map((a) => a.image)).size).toBe(actions.length);
  });

  it("drops the submenus that would be empty", () => {
    const ids = kanbanCardMenuActions({ columns: [], labels: [] }, card).map((a) => a.id);
    expect(ids).not.toContain("move");
    expect(ids).not.toContain("labels");
  });
});

describe("KanbanCardMenu", () => {
  it("shows no menu when the connection cannot edit", () => {
    mocks.canEdit = false;
    render();
    expect(host.textContent).toBe("tile");
    expect(host.querySelector("button")).toBeNull();
  });

  it("opens on long press and runs open", async () => {
    render();
    expect(host.querySelector("[data-long-press]")?.getAttribute("data-long-press")).toBe("true");
    await press("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("opens on a plain press behind a visible actions button", () => {
    render(true);
    expect(host.querySelector("[data-long-press]")?.getAttribute("data-long-press")).toBe("false");
  });

  it("renames through a prompt, ignoring blank or unchanged titles", async () => {
    render();
    await press("rename");
    const request = mocks.prompt.mock.calls[0]![0];
    expect(request.initialValue).toBe("Fix it");
    request.onConfirm("  ");
    request.onConfirm("Fix it");
    expect(mocks.updateCard).not.toHaveBeenCalled();
    request.onConfirm(" New ");
    expect(mocks.updateCard).toHaveBeenCalledWith({ cardId: "c1", title: "New" });
  });

  it("moves to a column and warns when the definition of done is unmet", async () => {
    render();
    await press("move:done");
    expect(mocks.moveCard).toHaveBeenCalledWith({ cardId: "c1", columnId: "done" });
    expect(mocks.alert).toHaveBeenCalledWith(
      "Moved without meeting the definition of done",
      expect.any(String),
    );
    mocks.alert.mockClear();
    mocks.moveCard.mockResolvedValue(false);
    await press("move:done");
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("toggles a label on and off", async () => {
    render();
    await press("label:ui");
    expect(mocks.updateCard).toHaveBeenLastCalledWith({ cardId: "c1", labelIds: ["bug", "ui"] });
    await press("label:bug");
    expect(mocks.updateCard).toHaveBeenLastCalledWith({ cardId: "c1", labelIds: [] });
  });

  it("sets the due date from a prompt and rejects a bad one", async () => {
    render();
    await press("due");
    const request = mocks.prompt.mock.calls[0]![0];
    request.onConfirm("nope");
    expect(mocks.alert).toHaveBeenCalledWith("Invalid date", expect.any(String));
    expect(mocks.updateCard).not.toHaveBeenCalled();
    request.onConfirm("");
    expect(mocks.updateCard).toHaveBeenCalledWith({ cardId: "c1", dueAt: null });
    request.onConfirm("2026-03-09");
    expect(mocks.updateCard).toHaveBeenLastCalledWith({
      cardId: "c1",
      dueAt: expect.stringContaining("2026-03-09"),
    });
  });

  it("archives at once and deletes only after confirming", async () => {
    render();
    await press("archive");
    expect(mocks.archiveCard).toHaveBeenCalledWith({ cardId: "c1" });

    await press("delete");
    expect(mocks.deleteCard).not.toHaveBeenCalled();
    const request = mocks.confirm.mock.calls[0]![0];
    expect(request.destructive).toBe(true);
    request.onConfirm();
    expect(mocks.deleteCard).toHaveBeenCalledWith({ cardId: "c1" });
  });
});

describe("promptDueDate", () => {
  it("starts from the current due date", () => {
    promptDueDate(null, vi.fn());
    expect(mocks.prompt.mock.calls[0]![0].initialValue).toBe("");
  });
});
