import {
  EnvironmentId,
  type KanbanBoardId,
  type KanbanCard,
  type KanbanCardId,
  type KanbanColumn,
  type KanbanColumnId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { KanbanColumns } from "./KanbanColumns";

const boardId = "b1" as KanbanBoardId;

function column(id: string, role: KanbanColumn["role"], wipLimit: number | null = null) {
  return {
    id: id as KanbanColumnId,
    boardId,
    name: id,
    color: "slate",
    orderKey: id,
    wipLimit,
    role,
  } satisfies KanbanColumn;
}

function card(id: string, columnId: string): KanbanCard {
  return {
    id: id as KanbanCardId,
    boardId,
    columnId: columnId as KanbanColumnId,
    orderKey: id,
    number: Number(id.slice(1)),
    title: `Task ${id}`,
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
  } as KanbanCard;
}

function setup() {
  const onMoveCard = vi.fn(() => Promise.resolve());
  const onAddCard = vi.fn();
  const ui = (
    <KanbanColumns
      environmentId={EnvironmentId.make("env")}
      columns={[
        { column: column("todo", "todo"), cards: [card("c1", "todo"), card("c2", "todo")] },
        { column: column("doing", "in-progress", 1), cards: [card("c3", "doing")] },
      ]}
      labels={[]}
      templates={[]}
      canEdit
      renderHeader={(entry, count) => <h3>{`${entry.name} ${count}`}</h3>}
      onOpenCard={vi.fn()}
      onMoveCard={onMoveCard}
      onMoveColumn={vi.fn(() => Promise.resolve())}
      onAddCard={onAddCard}
    />
  );
  return { ui, onMoveCard, onAddCard };
}

describe("KanbanColumns", () => {
  it("moves a card dragged onto another column", async () => {
    const { ui, onMoveCard } = setup();
    await using _screen = await render(ui, { router: false });
    const source = page.getByTestId("kanban-card").first().element().parentElement!;
    const target = page.getByTestId("kanban-card").nth(2).element().getBoundingClientRect();
    const from = source.getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    const liveText = () => document.querySelector("[aria-live]")?.textContent ?? "";
    source.dispatchEvent(pointer("pointerdown", from.x + 20, from.y + 20));
    document.dispatchEvent(pointer("pointermove", from.x + 40, from.y + 40));
    await vi.waitFor(() => expect(liveText()).toContain("droppable area c1"));
    const x = target.x + target.width / 2;
    const y = target.y + target.height / 2;
    document.dispatchEvent(pointer("pointermove", x, y));
    await vi.waitFor(() => expect(liveText()).toContain("droppable area c3"));
    document.dispatchEvent(pointer("pointerup", x, y));
    await vi.waitFor(() => expect(onMoveCard).toHaveBeenCalledTimes(1));
    expect(onMoveCard.mock.calls[0]).toMatchObject([
      { cardId: "c1", columnId: "doing" },
      { id: "todo" },
      { id: "doing" },
    ]);
  });

  it("adds a card from the column quick add on Enter", async () => {
    const { ui, onAddCard } = setup();
    await using _screen = await render(ui, { router: false });
    await userEvent.click(page.getByRole("button", { name: "Add a card" }).first());
    await userEvent.fill(page.getByLabelText("Card title"), "Ship it");
    await userEvent.keyboard("{Enter}");
    expect(onAddCard).toHaveBeenCalledWith("todo", "Ship it");
  });
});
