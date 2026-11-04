import { EnvironmentId, ThreadId, type KanbanCard } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ComposerKanbanCardChip } from "./ComposerKanbanCardChip";
import { KanbanThreadCardBadge } from "./KanbanThreadCardBadge";

const mocks = vi.hoisted(() => ({
  unlinkCardThread: vi.fn(),
  card: null as KanbanCard | null,
  canEdit: true,
}));

vi.mock("../../state/kanban", () => ({ useThreadKanbanCard: () => mocks.card }));
vi.mock("./useKanban", () => ({
  useKanbanCanEdit: () => mocks.canEdit,
  useKanbanActions: () => ({ unlinkCardThread: mocks.unlinkCardThread }),
}));

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

function setup(options: { canEdit?: boolean } = {}) {
  mocks.unlinkCardThread.mockReset().mockResolvedValue({ sequence: 1 });
  mocks.canEdit = options.canEdit ?? true;
  mocks.card = { id: "c1", number: 7, title: "Fix header" } as KanbanCard;
}

describe("KanbanThreadCardBadge menu", () => {
  it("unlinks and offers to switch cards", async () => {
    setup();
    const onLinkAnother = vi.fn();
    await using screen = await render(
      <KanbanThreadCardBadge
        environmentId={environmentId}
        threadId={threadId}
        showTitle
        onLinkAnother={onLinkAnother}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Board card #7, Fix header" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Link to another card…" }));
    expect(onLinkAnother).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Board card #7, Fix header" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Unlink from this thread" }));
    expect(mocks.unlinkCardThread).toHaveBeenCalledWith({ cardId: "c1", threadId });
  });

  it("keeps Open card for a read-only session and renders nothing without a card", async () => {
    setup({ canEdit: false });
    await using screen = await render(
      <KanbanThreadCardBadge
        environmentId={environmentId}
        threadId={threadId}
        onLinkAnother={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Board card #7, Fix header" }));
    await expect.element(page.getByRole("menuitem", { name: "Open card" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Unlink from this thread" }).elements()).toHaveLength(
      0,
    );
    mocks.card = null;
    await screen.rerender(
      <KanbanThreadCardBadge
        environmentId={environmentId}
        threadId={threadId}
        onLinkAnother={() => {}}
      />,
    );
    expect(screen.container.textContent).toBe("");
  });

  it("opens the card on a plain click without a menu", async () => {
    setup();
    await using screen = await render(
      <KanbanThreadCardBadge environmentId={environmentId} threadId={threadId} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Board card #7, Fix header" }));
    expect(page.getByRole("menuitem").elements()).toHaveLength(0);
  });
});

describe("ComposerKanbanCardChip", () => {
  it("removes the card from the next message and adds it back", async () => {
    setup();
    await using screen = await render(
      <ComposerKanbanCardChip environmentId={environmentId} threadId={threadId} messages={[]} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send without the card" }));
    await expect.element(screen.getByText("#7 Fix header left out")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Add back/ }));
    await expect.element(screen.getByText("goes with this message")).toBeVisible();
  });

  it("hides once a message holds the card", async () => {
    setup();
    const delivered = [
      { context: { version: 1 as const, records: [{ kind: "kanban-card", cardId: "c1" }] } },
    ];
    await using screen = await render(
      <ComposerKanbanCardChip
        environmentId={environmentId}
        threadId={threadId}
        messages={delivered as never}
      />,
    );
    expect(screen.container.textContent).toBe("");
  });
});
