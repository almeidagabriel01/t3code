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
import { KanbanCardDetail } from "./KanbanCardDetail";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  updateCard: vi.fn(),
  setCardProblemIgnored: vi.fn(),
}));

vi.mock("../../lib/attachmentUploadQueue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadStandaloneAttachment: mocks.upload,
}));
vi.mock("../../assets/assetUrls", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAssetUrlState: () => ({ _tag: "Initial" }),
}));
vi.mock("../../state/query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEnvironmentQuery: () => ({ data: undefined, error: null, isPending: false, refresh() {} }),
}));
vi.mock("./useKanban", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useKanbanActions: () => ({
    updateCard: mocks.updateCard,
    setCardProblemIgnored: mocks.setCardProblemIgnored,
  }),
}));

function setup() {
  mocks.upload.mockReset().mockReturnValue(new Promise(() => {}));
  mocks.updateCard.mockReset().mockResolvedValue(null);
  mocks.setCardProblemIgnored.mockReset().mockResolvedValue(null);
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
  problem: null,
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

  it("shows the drop-to-attach overlay over the panel but not over the description editor", async () => {
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
    const drag = (target: Element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
      target.dispatchEvent(
        new DragEvent("dragover", { dataTransfer, bubbles: true, cancelable: true }),
      );
    };
    drag(title.element());
    await expect.element(page.getByText("Drop to attach")).toBeVisible();
    await page.getByRole("button", { name: "Add a description" }).click();
    drag(page.getByRole("textbox", { name: "Description" }).element());
    await expect.element(page.getByText("Drop to attach")).not.toBeInTheDocument();
  });

  it("shows an image pasted into the description as the image, then saves its markdown ref", async () => {
    setup();
    let finish: (value: { attachmentId: string; mimeType: string }) => void = () => {};
    mocks.upload.mockReturnValue(new Promise((resolve) => (finish = resolve)));
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
    await page.getByRole("button", { name: "Add a description" }).click();
    const editor = page.getByRole("textbox", { name: "Description" });
    await expect.element(editor).toBeVisible();

    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }),
    );
    editor
      .element()
      .dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );

    const image = editor.getByRole("img", { name: "shot.png" });
    await expect.element(image).toBeVisible();
    expect(image.element().getAttribute("src")).toMatch(/^blob:/);
    expect(editor.element().textContent).not.toContain("t3-attachment");
    expect(document.querySelector('[data-testid="kanban-attachment-upload"]')).toBeNull();
    await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();

    finish({ attachmentId: "att-1", mimeType: "image/png" });
    await expect.element(page.getByRole("button", { name: "Save" })).toBeEnabled();
    await page.getByRole("button", { name: "Save" }).click();
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.updateCard).toHaveBeenCalledWith({
      cardId: card.id,
      description: "![shot.png](t3-attachment:att-1)",
    });
  });

  it("saves typed markdown blocks as the markdown they show", async () => {
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
    await page.getByRole("button", { name: "Add a description" }).click();
    const editor = page.getByRole("textbox", { name: "Description" });
    await userEvent.type(editor, "## Steps{Enter}1. first{Enter}second");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    // Markdown numbers ordered items itself, so a repeated `1.` still renders 1, 2.
    expect(mocks.updateCard).toHaveBeenCalledWith({
      cardId: card.id,
      description: expect.stringMatching(/^## Steps\n1\. first\n\d+\. second$/),
    });
  });
});

describe("KanbanCardDetail problem block", () => {
  const previous = { ...card, id: "c0" as KanbanCardId, number: 7, title: "Old cause" };
  it.each([
    {
      name: "an open problem with an owner and a previous card on the board",
      problem: { kind: "ci", count: 3, ownerName: "Jarvis", previousCardNumber: 7, ignored: false },
      lines: ["Seen 3 times", "Handled by Jarvis", "Previous card: #7"],
      button: "Ignore this problem",
      ignored: true,
    },
    {
      name: "an ignored problem with no owner and no previous card",
      problem: {
        kind: "environment",
        count: 1,
        ownerName: null,
        previousCardNumber: null,
        ignored: true,
      },
      lines: [],
      button: "Stop ignoring",
      ignored: false,
    },
  ] as const)("$name", async ({ problem, lines, button, ignored }) => {
    setup();
    const onOpenCard = vi.fn();
    const problemCard = { ...card, problem } as KanbanCard;
    await using _screen = await render(
      <KanbanCardDetail
        environmentId={EnvironmentId.make("env")}
        board={
          {
            ...board,
            cards: new Map([
              [problemCard.id, problemCard],
              [previous.id, previous],
            ]),
          } as unknown as KanbanBoardState
        }
        card={problemCard}
        canEdit
        onOpenCard={onOpenCard}
        onClose={() => {}}
      />,
    );
    for (const line of lines) await expect.element(page.getByText(line)).toBeVisible();
    if (problem.ownerName === null) expect(page.getByText(/Handled by/).query()).toBeNull();
    if (problem.count === 1) expect(page.getByText(/Seen \d+ times/).query()).toBeNull();
    if (problem.previousCardNumber !== null) {
      await userEvent.click(page.getByRole("button", { name: "Previous card: #7" }));
      expect(onOpenCard).toHaveBeenCalledWith(previous);
    }
    await userEvent.click(page.getByRole("button", { name: button }));
    expect(mocks.setCardProblemIgnored).toHaveBeenCalledWith({ cardId: card.id, ignored });

    await userEvent.click(page.getByRole("button", { name: "Card actions" }));
    await expect.element(page.getByRole("menuitem", { name: button })).toBeVisible();
  });

  it("shows no problem block on an ordinary card", async () => {
    setup();
    await using _screen = await render(
      <KanbanCardDetail
        environmentId={EnvironmentId.make("env")}
        board={board}
        card={{ ...card, problem: null }}
        canEdit
        onOpenCard={() => {}}
        onClose={() => {}}
      />,
    );
    await expect.element(page.getByRole("textbox", { name: "Title" })).toBeVisible();
    expect(page.getByText(/Seen \d+ times/).query()).toBeNull();
    expect(page.getByRole("button", { name: "Ignore this problem" }).query()).toBeNull();
  });
});
