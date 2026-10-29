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
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { KanbanCardDetail } from "./KanbanCardDetail";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  updateCard: vi.fn(),
}));

vi.mock("../../lib/attachmentUploadQueue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadStandaloneAttachment: mocks.upload,
}));
vi.mock("../../state/query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEnvironmentQuery: () => ({ data: undefined, error: null, isPending: false, refresh() {} }),
}));
vi.mock("./useKanban", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useKanbanActions: () => ({ updateCard: mocks.updateCard }),
}));

function setup() {
  mocks.upload.mockReset().mockReturnValue(new Promise(() => {}));
  mocks.updateCard.mockReset().mockResolvedValue(null);
}

const boardId = "b1" as KanbanBoardId;
const columnId = "todo" as KanbanColumnId;
const card = {
  id: "c1" as KanbanCardId,
  boardId,
  columnId,
  orderKey: "a",
  number: 1,
  title: "Fix the header",
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
  columns: [
    {
      id: columnId,
      boardId,
      name: "To do",
      color: "blue",
      orderKey: "a",
      wipLimit: null,
      role: "todo",
    },
  ],
  labels: [],
  templates: [],
  cards: new Map([[card.id, card]]),
} as unknown as KanbanBoardState;

describe("KanbanCardDetail attachments", () => {
  it("shows a pasted image as a local preview before its upload finishes", async () => {
    setup();
    await using _screen = await render(
      <KanbanCardDetail
        environmentId={EnvironmentId.make("env")}
        board={board}
        card={card}
        canEdit
        onOpenCard={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const title = page.getByRole("textbox", { name: "Title" });
    await expect.element(title).toBeVisible();

    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }),
    );
    title
      .element()
      .dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );

    const preview = page.getByRole("img", { name: "shot.png" });
    await expect.element(preview).toBeVisible();
    expect(preview.element().getAttribute("src")).toMatch(/^blob:/);
    await expect
      .element(page.getByRole("progressbar", { name: "Uploading shot.png" }))
      .toHaveAttribute("aria-valuenow", "0");
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.updateCard).not.toHaveBeenCalled();
  });
});
