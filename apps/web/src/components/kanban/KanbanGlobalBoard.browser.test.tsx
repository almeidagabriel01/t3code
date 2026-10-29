import type { KanbanState } from "@t3tools/client-runtime/state/kanban";
import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { KanbanGlobalBoard } from "./KanbanGlobalBoard";
import type { KanbanProjectInfo } from "./KanbanProjectBadge";

const mocks = vi.hoisted(() => ({
  ensureBoard: vi.fn(),
  createCard: vi.fn(),
}));

vi.mock("./useKanban", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useKanbanCanEdit: () => true,
  useKanbanActions: (environmentId: string) => ({
    ensureBoard: (input: unknown) => mocks.ensureBoard(environmentId, input),
    createCard: (input: unknown) => mocks.createCard(environmentId, input),
  }),
}));

function setup() {
  mocks.ensureBoard.mockReset().mockResolvedValue({ sequence: 1, boardId: "new-board" });
  mocks.createCard.mockReset().mockResolvedValue({ sequence: 2, cardId: "c1" });
}

function project(environmentId: EnvironmentId, id: string, name: string) {
  const info: KanbanProjectInfo = {
    name,
    projectKey: name.toLowerCase(),
    project: {
      environmentId,
      id: id as ProjectId,
      workspaceRoot: `/work/${id}`,
      title: name,
      faviconPath: null,
      projectIcon: null,
    } as KanbanProjectInfo["project"],
  };
  return [`${environmentId}:${id}`, info] as const;
}

describe("KanbanGlobalBoard", () => {
  it("creates a card in the chosen project, starting that project's board", async () => {
    setup();
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const empty = { boards: new Map() } as unknown as KanbanState;
    await using _screen = await render(
      <KanbanGlobalBoard
        states={[
          { environmentId: local, state: empty, error: null },
          { environmentId: remote, state: empty, error: null },
        ]}
        projects={new Map([project(local, "p1", "Alpha"), project(remote, "p2", "Beta")])}
        onOpenCard={vi.fn()}
      />,
    );

    await page.getByRole("button", { name: "New card" }).click();
    await page.getByRole("combobox", { name: "Project" }).click();
    await page.getByRole("option", { name: "Beta" }).click();
    await userEvent.type(page.getByRole("textbox", { name: "Title" }), "Ship it");
    await page.getByRole("button", { name: "Add card" }).click();

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.ensureBoard).toHaveBeenCalledWith(remote, { projectId: "p2" });
    expect(mocks.createCard).toHaveBeenCalledWith(remote, {
      boardId: "new-board",
      title: "Ship it",
    });
  });
});
