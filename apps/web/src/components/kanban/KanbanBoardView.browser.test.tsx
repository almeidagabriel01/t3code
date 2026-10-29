import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import {
  EnvironmentId,
  type KanbanBoardId,
  type KanbanCard,
  type KanbanCardId,
  type KanbanColumnId,
  type ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { KanbanBoardView } from "./KanbanBoardView";

const mocks = vi.hoisted(() => ({ updateCard: vi.fn(), moveCard: vi.fn() }));

vi.mock("./useKanban", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useKanbanCanEdit: () => true,
  useKanbanActions: () => ({ updateCard: mocks.updateCard, moveCard: mocks.moveCard }),
}));

function setup() {
  mocks.updateCard.mockReset().mockResolvedValue({ sequence: 1 });
  mocks.moveCard.mockReset().mockResolvedValue({ sequence: 1 });
}

const boardId = "b1" as KanbanBoardId;
const columns = (["todo", "doing"] as const).map((id, index) => ({
  id: id as KanbanColumnId,
  boardId,
  name: id === "todo" ? "To do" : "Doing",
  color: "blue",
  orderKey: String(index),
  wipLimit: null,
  role: "none" as const,
}));
const card = {
  id: "c1" as KanbanCardId,
  boardId,
  columnId: columns[0]!.id,
  orderKey: "a",
  number: 7,
  title: "Fix header",
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
} as KanbanCard;
const board = {
  id: boardId,
  projectId: "p1" as ProjectId,
  title: "Board",
  automations: { definitionOfDone: false },
  columns,
  labels: [],
  templates: [],
  cards: new Map([[card.id, card]]),
} as unknown as KanbanBoardState;

describe("KanbanBoardView quick edit", () => {
  it("renames and moves a card from the tile without opening it", async () => {
    setup();
    const onOpenCard = vi.fn();
    await using _screen = await render(
      <KanbanBoardView
        environmentId={EnvironmentId.make("env")}
        board={board}
        canEdit
        onOpenCard={onOpenCard}
      />,
    );

    const pencil = page.getByRole("button", { name: "Quick edit #7" });
    (pencil.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    const title = page.getByRole("textbox", { name: "Card title" });
    await expect.element(title).toHaveValue("Fix header");

    await userEvent.clear(title);
    await userEvent.type(title, "a b{Enter}");
    expect(mocks.updateCard).toHaveBeenCalledWith({ cardId: card.id, title: "a b" });
    await expect.element(title).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Quick edit #7" }).click();
    await page.getByRole("button", { name: "Move" }).click();
    await page.getByRole("menuitemradio", { name: "Doing" }).click();
    expect(mocks.moveCard).toHaveBeenCalledWith({ cardId: card.id, columnId: "doing" });
    expect(onOpenCard).not.toHaveBeenCalled();
  });
});
