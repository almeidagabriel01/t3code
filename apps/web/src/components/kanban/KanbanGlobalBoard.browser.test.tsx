import type { KanbanState } from "@t3tools/client-runtime/state/kanban";
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
import { KanbanGlobalBoard } from "./KanbanGlobalBoard";
import type { KanbanProjectInfo } from "./KanbanProjectBadge";

const mocks = vi.hoisted(() => ({
  ensureBoard: vi.fn(),
  createCard: vi.fn(),
  openScratchProject: vi.fn(),
  scratchEnvironmentId: vi.fn(),
}));

vi.mock("~/hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: mocks.scratchEnvironmentId,
    openScratchProject: mocks.openScratchProject,
  }),
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
  mocks.openScratchProject.mockReset().mockResolvedValue({ id: "scratch" });
  mocks.scratchEnvironmentId.mockReset().mockReturnValue(null);
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

  it("adds the card when Enter is pressed in the title", async () => {
    setup();
    const local = EnvironmentId.make("local");
    const empty = { boards: new Map() } as unknown as KanbanState;
    await using _screen = await render(
      <KanbanGlobalBoard
        states={[{ environmentId: local, state: empty, error: null }]}
        projects={new Map([project(local, "p1", "Alpha")])}
        onOpenCard={vi.fn()}
      />,
    );

    await page.getByRole("button", { name: "New card" }).click();
    await userEvent.type(page.getByRole("textbox", { name: "Title" }), "Ship it{Enter}");

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.createCard).toHaveBeenCalledWith(local, {
      boardId: "new-board",
      title: "Ship it",
    });
  });

  it("offers No project before its project exists, ensuring it then its board", async () => {
    setup();
    const local = EnvironmentId.make("local");
    mocks.scratchEnvironmentId.mockReturnValue(local);
    const empty = { boards: new Map() } as unknown as KanbanState;
    await using _screen = await render(
      <KanbanGlobalBoard
        states={[{ environmentId: local, state: empty, error: null }]}
        projects={new Map([project(local, "p1", "Alpha")])}
        onOpenCard={vi.fn()}
      />,
    );

    await page.getByRole("button", { name: "New card" }).click();
    await page.getByRole("combobox", { name: "Project" }).click();
    await page.getByRole("option", { name: "No project" }).click();
    await userEvent.type(page.getByRole("textbox", { name: "Title" }), "Renew domain{Enter}");

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.openScratchProject).toHaveBeenCalledWith(local);
    expect(mocks.ensureBoard).toHaveBeenCalledWith(local, { projectId: "scratch" });
    expect(mocks.createCard).toHaveBeenCalledWith(local, {
      boardId: "new-board",
      title: "Renew domain",
    });
  });

  it("offers no No project option where threads without a project are unavailable", async () => {
    setup();
    const local = EnvironmentId.make("local");
    const empty = { boards: new Map() } as unknown as KanbanState;
    await using _screen = await render(
      <KanbanGlobalBoard
        states={[{ environmentId: local, state: empty, error: null }]}
        projects={new Map([project(local, "p1", "Alpha")])}
        onOpenCard={vi.fn()}
      />,
    );

    await page.getByRole("button", { name: "New card" }).click();
    await page.getByRole("combobox", { name: "Project" }).click();
    await expect.element(page.getByRole("option", { name: "Alpha" })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: "No project" })).not.toBeInTheDocument();
  });

  it("shows the No-project board's cards with its badge and filter entry", async () => {
    setup();
    const local = EnvironmentId.make("local");
    const boardId = "b-scratch" as KanbanBoardId;
    const columnId = "todo" as KanbanColumnId;
    const card = {
      id: "c1" as KanbanCardId,
      boardId,
      columnId,
      orderKey: "a",
      number: 3,
      title: "Renew domain",
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
    } as unknown as KanbanCard;
    const board = {
      id: boardId,
      projectId: "scratch" as ProjectId,
      title: "Board",
      automations: { definitionOfDone: false },
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
    };
    const [key, info] = project(local, "scratch", "No project");
    await using _screen = await render(
      <KanbanGlobalBoard
        states={[
          {
            environmentId: local,
            state: { boards: new Map([[boardId, board]]) } as never,
            error: null,
          },
        ]}
        projects={
          new Map([[key, { ...info, project: { ...info.project, isScratch: true as const } }]])
        }
        onOpenCard={vi.fn()}
      />,
    );

    await expect.element(page.getByText("Renew domain")).toBeInTheDocument();
    await expect.element(page.getByText("No project").first()).toBeInTheDocument();
    await page.getByRole("button", { name: /Projects/ }).click();
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "No project" }))
      .toBeInTheDocument();
  });
});
