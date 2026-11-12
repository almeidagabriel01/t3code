import type { KanbanBoardState, KanbanState } from "@t3tools/client-runtime/state/kanban";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type KanbanBoardId,
  type KanbanCard,
  type KanbanCardId,
  type KanbanColumnId,
  type KanbanLabelId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const scratchId = ProjectId.make("scratch");

const state = vi.hoisted(() => ({
  entries: [] as Array<{ environmentId: string; state: unknown; error: string | null }>,
  canEdit: true,
  project: null as { id: string; title: string; isScratch?: true } | null,
  projects: [] as Array<{ id: string; environmentId: string; isScratch?: true }>,
  actions: {
    ensureBoard: vi.fn(),
    createCard: vi.fn(),
    moveCard: vi.fn(),
    archiveCard: vi.fn(),
  },
  openScratch: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock(import("./useKanban"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKanbanStates: (() => state.entries) as never,
  useKanbanCanEdit: () => state.canEdit,
  useKanbanActions: (() => state.actions) as never,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: (() => state.project) as never,
  useProjects: (() => state.projects) as never,
  useQuietThreadShell: ((ref: { threadId: string }) =>
    ref.threadId === "unknown"
      ? null
      : {
          hasPendingApprovals: ref.threadId === "asking",
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          runtime: { status: ref.threadId === "working" ? "running" : "idle" },
        }) as never,
}));
vi.mock(import("../../hooks/useScratchProject"), () => ({
  useScratchProject: (() => ({ openScratchProject: state.openScratch })) as never,
}));
vi.mock(import("../../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: (() => [
    { projectKey: "group-1", memberProjects: [{ environmentId, id: projectId }] },
  ]) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => state.navigate,
}));
vi.mock(import("./KanbanCardDetail"), () => ({
  KanbanCardDetail: ((props: { card: KanbanCard; onClose: () => void }) => (
    <div role="dialog" aria-label={`Card ${props.card.title}`}>
      <button type="button" onClick={props.onClose}>
        Close card
      </button>
    </div>
  )) as never,
}));

import "~/index.css";
import { render } from "../../../test/render";
import { useKanbanPanelStore } from "./kanbanPanelStore";
import { KanbanSurface } from "./KanbanSurface";

const boardId = "b1" as KanbanBoardId;
const column = (id: string, name: string, role: string, orderKey: string) => ({
  id: id as KanbanColumnId,
  boardId,
  name,
  color: "blue",
  orderKey,
  wipLimit: null,
  role,
});
const columns = [
  column("todo", "To do", "todo", "a"),
  column("doing", "Doing", "in-progress", "b"),
  column("done", "Done", "done", "c"),
];
const label = (id: string, name: string) => ({ id: id as KanbanLabelId, name, color: "green" });
const card = (
  id: string,
  number: number,
  title: string,
  columnId: string,
  orderKey: string,
  extra: Partial<KanbanCard> = {},
) =>
  ({
    id: id as KanbanCardId,
    boardId,
    columnId: columnId as KanbanColumnId,
    orderKey,
    number,
    title,
    priority: "none",
    labelIds: [],
    checklist: [],
    linkedThreadIds: [],
    blockedBy: [],
    archivedAt: null,
    ...extra,
  }) as KanbanCard;
const cards = [
  card("c1", 1, "Fix header", "todo", "a", {
    priority: "high",
    labelIds: ["l1", "l2", "l3"] as KanbanLabelId[],
    checklist: [
      { id: "i1" as never, text: "a", done: true },
      { id: "i2" as never, text: "b", done: false },
    ],
    linkedThreadIds: [ThreadId.make("working"), ThreadId.make("asking"), ThreadId.make("unknown")],
  }),
  card("c2", 2, "Write docs", "todo", "b", { linkedThreadIds: [ThreadId.make("idle")] }),
  card("c3", 3, "Ship release", "done", "a"),
];
const board = (owner = projectId, id = boardId) =>
  ({
    id,
    projectId: owner,
    title: "Board",
    automations: { definitionOfDone: false },
    columns,
    labels: [label("l1", "Bug"), label("l2", "UI"), label("l3", "Docs")],
    templates: [],
    cards: new Map(cards.map((entry) => [entry.id, entry])),
  }) as unknown as KanbanBoardState;
const kanbanState = (...boards: KanbanBoardState[]): KanbanState =>
  ({ sequence: 1, boards: new Map(boards.map((entry) => [entry.id, entry])) }) as KanbanState;

function setup(
  input: { boards?: KanbanBoardState[]; state?: "loading" | "error" | "missing" } = {},
) {
  useKanbanPanelStore.setState({ scopeByProject: {}, collapsedByBoard: {} });
  state.canEdit = true;
  state.project = { id: projectId, title: "Website" };
  state.projects = [];
  state.entries =
    input.state === "missing"
      ? []
      : [
          {
            environmentId,
            state: input.state === "loading" ? null : kanbanState(...(input.boards ?? [board()])),
            error: input.state === "error" ? "Could not load boards." : null,
          },
        ];
  for (const action of Object.values(state.actions))
    action.mockReset().mockResolvedValue({ sequence: 1 });
  state.actions.ensureBoard.mockResolvedValue({ sequence: 1, boardId: "b2" });
  state.openScratch.mockReset().mockResolvedValue({ id: scratchId, environmentId });
  state.navigate.mockReset();
}

const surface = () => <KanbanSurface environmentId={environmentId} projectId={projectId} />;
const section = (name: string) => page.getByRole("region", { name });

it("shows one section per column with compact rows, and remembers collapsed sections", async () => {
  setup();
  await using _screen = await render(surface());

  await expect.element(section("To do").getByText("Fix header")).toBeVisible();
  await expect.element(section("Doing").getByText("No cards")).toBeVisible();
  await expect.element(page.getByText("Ship release")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Choose board" }))
    .toHaveTextContent("Website");

  const row = section("To do").getByRole("listitem").first();
  await expect.element(row.getByLabelText("Checklist 1 of 2 done")).toBeVisible();
  await expect.element(row.getByLabelText("High")).toBeVisible();
  await expect.element(row.getByText("Bug")).toBeVisible();
  await expect.element(row.getByText("+1")).toBeVisible();
  await expect.element(row.getByRole("img", { name: "Linked agent working" })).toBeVisible();
  await expect.element(row.getByRole("img", { name: "Linked agent needs you" })).toBeVisible();
  await expect
    .element(section("To do").getByRole("img", { name: "Linked agent idle" }))
    .toBeVisible();

  await section("Done").getByRole("button", { name: /^Done/ }).click();
  await expect.element(page.getByText("Ship release")).toBeVisible();
  await section("To do")
    .getByRole("button", { name: /^To do/ })
    .click();
  await expect.element(page.getByText("Fix header")).not.toBeInTheDocument();
  expect(useKanbanPanelStore.getState().collapsedByBoard[boardId]).toEqual({
    done: false,
    todo: true,
  });
});

it("moves and archives a card from its menu", async () => {
  setup();
  await using _screen = await render(surface());

  await page.getByRole("button", { name: "Actions for #1" }).click();
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menuitem", { name: "Doing" }).click();
  expect(state.actions.moveCard).toHaveBeenCalledWith({ cardId: "c1", columnId: "doing" });

  await page.getByRole("button", { name: "Actions for #2" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  expect(state.actions.archiveCard).toHaveBeenCalledWith({ cardId: "c2" });
});

it("moves a card by keyboard drag", async () => {
  setup();
  await using _screen = await render(surface());
  const row = document.querySelector<HTMLElement>('[data-kanban-card="c2"]')!;
  row.focus();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowUp}");
  await userEvent.keyboard(" ");
  await vi.waitFor(() =>
    expect(state.actions.moveCard).toHaveBeenCalledWith({
      cardId: "c2",
      columnId: "todo",
      beforeCardId: "c1",
    }),
  );
});

it("adds cards from the header and from a section", async () => {
  setup();
  await using _screen = await render(surface());

  await page.getByRole("button", { name: "New" }).click();
  const title = page.getByRole("textbox", { name: "New card title" });
  await userEvent.type(title, "Ship it{Enter}");
  expect(state.actions.createCard).toHaveBeenCalledWith({ boardId, title: "Ship it" });
  await expect.element(title).toHaveValue("");
  await userEvent.keyboard("{Escape}");
  await expect.element(title).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Add a card to Doing" }).click();
  await userEvent.type(page.getByRole("textbox", { name: "New card title" }), "Review{Enter}");
  expect(state.actions.createCard).toHaveBeenLastCalledWith({
    boardId,
    title: "Review",
    columnId: "doing",
  });
  await page.getByRole("button", { name: "Add" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "New card title" }))
    .not.toBeInTheDocument();
});

it("opens a card in place, on the full board, and the full board itself", async () => {
  setup();
  await using _screen = await render(surface());

  await page.getByText("Fix header").click();
  await expect.element(page.getByRole("dialog", { name: "Card Fix header" })).toBeVisible();
  await page.getByRole("button", { name: "Close card" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Actions for #1" }).click();
  await page.getByRole("menuitem", { name: "Open card" }).click();
  await expect.element(page.getByRole("dialog", { name: "Card Fix header" })).toBeVisible();
  await page.getByRole("button", { name: "Close card" }).click();

  await page.getByRole("button", { name: "Actions for #1" }).click();
  await page.getByRole("menuitem", { name: "Open on board" }).click();
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/kanban",
    search: { projectKey: "group-1", card: "c1" },
  });

  await page.getByRole("button", { name: "Open the full board" }).click();
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/kanban",
    search: { projectKey: "group-1" },
  });
});

it("switches to the No project board and creates it with the first card", async () => {
  setup();
  await using _screen = await render(surface());

  await page.getByRole("button", { name: "Choose board" }).click();
  await page.getByRole("menuitem", { name: "No project" }).click();
  await expect.element(page.getByText("No cards without a project")).toBeVisible();
  expect(useKanbanPanelStore.getState().scopeByProject).toEqual({ "env:project": "no-project" });
  expect(state.actions.ensureBoard).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "New" }).click();
  await userEvent.type(page.getByRole("textbox", { name: "New card title" }), "Loose idea{Enter}");
  await vi.waitFor(() =>
    expect(state.actions.createCard).toHaveBeenCalledWith({ boardId: "b2", title: "Loose idea" }),
  );
  expect(state.openScratch).toHaveBeenCalledWith(environmentId);
  expect(state.actions.ensureBoard).toHaveBeenCalledWith({ projectId: scratchId });
});

it("shows the No project board's cards when the thread has no project", async () => {
  setup({ boards: [board(scratchId)] });
  state.project = { id: scratchId, title: "Scratch", isScratch: true };
  await using _screen = await render(
    <KanbanSurface environmentId={environmentId} projectId={scratchId} />,
  );
  await expect.element(page.getByText("Fix header")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Choose board" })).not.toBeInTheDocument();
  await expect.element(page.getByText("No project", { exact: true })).toBeVisible();
});

it("does not add a card when the No project board cannot be created", async () => {
  setup();
  state.openScratch.mockResolvedValue(null);
  useKanbanPanelStore.getState().setScope("env:project", "no-project");
  await using _screen = await render(surface());
  await page.getByRole("button", { name: "New" }).click();
  await userEvent.type(page.getByRole("textbox", { name: "New card title" }), "Lost{Enter}");
  await vi.waitFor(() => expect(state.openScratch).toHaveBeenCalled());
  expect(state.actions.createCard).not.toHaveBeenCalled();
});

it("sets up a missing project board for an editor", async () => {
  setup({ boards: [] });
  await using _screen = await render(surface());
  await expect.element(page.getByText("Setting up the board…")).toBeVisible();
  expect(state.actions.ensureBoard).toHaveBeenCalledWith({ projectId });
});

it.each([
  ["unavailable", { state: "missing" as const }, true, "Boards are not available"],
  ["failed", { state: "error" as const }, true, "Could not load the board"],
  ["loading", { state: "loading" as const }, true, "Loading board…"],
  ["missing for a viewer", { boards: [] }, false, "No board yet"],
])("shows the %s state", async (_name, input, canEdit, text) => {
  setup(input);
  state.canEdit = canEdit;
  await using _screen = await render(surface());
  await expect.element(page.getByText(text)).toBeVisible();
});
