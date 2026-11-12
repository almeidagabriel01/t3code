import type { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    states: [] as unknown[],
    projects: [] as unknown[],
    canEdit: true,
    prefs: { scopes: {}, collapsed: {} } as {
      scopes: Record<string, string>;
      collapsed: Record<string, Record<string, boolean>>;
    },
    setScope: vi.fn(),
    setCollapsed: vi.fn(),
    ensureBoard: vi.fn(),
    createOnNewBoard: vi.fn(),
    createCard: vi.fn(),
    prompt: vi.fn(),
    navigate: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    accessibilityLabel?: string;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ prompt: mocks.prompt }));
vi.mock("../../components/ui/IconButton", () => ({
  IconButton: (props: { accessibilityLabel: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: ReadonlyArray<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        >
          {`pick ${action.title}`}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: {
    actions: ReadonlyArray<{ accessibilityLabel: string; onPress: () => void }>;
    children?: ReactNode;
  }) => (
    <>
      {props.actions.map((action) => (
        <button
          key={action.accessibilityLabel}
          aria-label={action.accessibilityLabel}
          onClick={action.onPress}
        />
      ))}
      {props.children}
    </>
  ),
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("./KanbanCardTile", () => ({
  KanbanCardTile: (props: {
    card: { title: string };
    onPress: () => void;
    accessory?: ReactNode;
  }) => (
    <>
      <button onClick={props.onPress}>{`tile ${props.card.title}`}</button>
      {props.accessory}
    </>
  ),
}));
vi.mock("./KanbanCardMenu", () => ({ KanbanCardMenu: Children }));
vi.mock("./useKanbanActions", () => ({
  useKanbanActions: () => ({ canEdit: mocks.canEdit, createCard: mocks.createCard }),
}));
vi.mock("./useCreateKanbanBoard", () => ({
  useCreateKanbanBoard: () => mocks.ensureBoard,
  useCreateKanbanCard: () => mocks.createOnNewBoard,
}));
vi.mock("./useKanbanPanelPreferences", () => ({
  useKanbanPanelPreferences: () => ({
    ...mocks.prefs,
    setScope: mocks.setScope,
    setCollapsed: mocks.setCollapsed,
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  useServerConfigs: () => new Map([["env", { scratchWorkspaceRoot: "/scratch" }]]),
}));
vi.mock("../../state/kanban", () => ({ useKanbanStates: () => mocks.states }));

import { ProjectKanbanRouteScreen } from "./ProjectKanbanRouteScreen";

const environmentId = "env" as EnvironmentId;
const column = (id: string, role: string, orderKey: string) => ({
  id,
  boardId: "b1",
  name: id === "todo" ? "Todo" : "Done",
  color: id === "todo" ? "blue" : null,
  orderKey,
  wipLimit: id === "todo" ? 1 : null,
  role,
});
const card = (id: string, columnId: string, title: string) => ({
  id,
  columnId,
  orderKey: id,
  number: Number(id.slice(1)),
  title,
});
const board = {
  id: "b1",
  projectId: "p1",
  columns: [column("todo", "todo", "a"), column("done", "done", "b")],
  cards: new Map([
    ["c1", card("c1", "todo", "Write spec")],
    ["c2", card("c2", "todo", "Fix login")],
    ["c3", card("c3", "done", "Ship it")],
  ]),
};
const withBoards = (...boards: unknown[]) => {
  mocks.states = [
    {
      environmentId,
      state: { boards: new Map(boards.map((entry) => [(entry as { id: string }).id, entry])) },
      error: false,
    },
  ];
};

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.projects = [
    { environmentId, id: "p1", title: "Alpha", workspaceRoot: "/alpha" },
    { environmentId, id: "s1", title: "Scratch", workspaceRoot: "/scratch" },
  ];
  withBoards(board);
  mocks.canEdit = true;
  mocks.prefs = { scopes: {}, collapsed: {} };
  for (const mock of [
    mocks.setScope,
    mocks.setCollapsed,
    mocks.ensureBoard,
    mocks.createOnNewBoard,
    mocks.createCard,
    mocks.prompt,
    mocks.navigate,
  ]) {
    mock.mockReset();
  }
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const mount = (projectId = "p1") =>
  act(async () =>
    root.render(
      <ProjectKanbanRouteScreen route={{ params: { environmentId, projectId } } as never} />,
    ),
  );
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  );
const press = (label: string) => act(async () => button(label)?.click());
const confirmPrompt = (value: string) =>
  act(async () => mocks.prompt.mock.calls.at(-1)![0].onConfirm(value));

describe("ProjectKanbanRouteScreen", () => {
  it("shows a section per column with Done folded, and folds a section on press", async () => {
    await mount();
    expect(host.textContent).toContain("tile Write spec");
    expect(host.textContent).toContain("tile Fix login");
    expect(host.textContent).toContain("2/1");
    expect(host.textContent).not.toContain("tile Ship it");

    await press("Done, 1 card");
    expect(mocks.setCollapsed).toHaveBeenCalledWith("b1", "done", false);
    await press("Todo, 2 cards");
    expect(mocks.setCollapsed).toHaveBeenCalledWith("b1", "todo", true);

    mocks.prefs = { scopes: {}, collapsed: { b1: { todo: true, done: false } } };
    await mount();
    expect(host.textContent).not.toContain("tile Write spec");
    expect(host.textContent).toContain("tile Ship it");
  });

  it("opens a card, offers its actions, and opens the full board on this project", async () => {
    await mount();
    await press("tile Write spec");
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsKanbanCard", {
      environmentId,
      cardId: "c1",
    });
    expect(button("Actions for #1")).toBeDefined();
    await press("Open the full board");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsKanban", { scope: "env:p1" });
  });

  it("adds a card to a column, or to the default column from New card", async () => {
    await mount();
    await press("Add a card to Todo");
    await confirmPrompt("  ");
    expect(mocks.createCard).not.toHaveBeenCalled();
    await confirmPrompt(" Plan ");
    expect(mocks.createCard).toHaveBeenCalledWith({
      boardId: "b1",
      title: "Plan",
      columnId: "todo",
    });

    await press("New card");
    await confirmPrompt("Loose");
    expect(mocks.createCard).toHaveBeenLastCalledWith({ boardId: "b1", title: "Loose" });
  });

  it("switches to the No project board, which waits for a card before it exists", async () => {
    await mount();
    await press("pick No project");
    expect(mocks.setScope).toHaveBeenCalledWith("env:p1", "no-project");

    mocks.prefs = { scopes: { "env:p1": "no-project" }, collapsed: {} };
    await mount();
    expect(host.textContent).toContain("No cards without a project");
    expect(mocks.ensureBoard).not.toHaveBeenCalled();
    await press("New card");
    await confirmPrompt("Idea");
    expect(mocks.createOnNewBoard).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, projectId: "s1" }),
      "Idea",
    );
  });

  it("shows only the No project board on a thread in no project", async () => {
    withBoards({ ...board, id: "b2", projectId: "s1" });
    await mount("s1");
    expect(button("Choose board")).toBeUndefined();
    expect(host.textContent).toContain("No project");
    expect(host.textContent).toContain("tile Write spec");
  });

  it("creates the project's board once when an editor first views it", async () => {
    withBoards();
    await mount();
    expect(host.textContent).toContain("Setting up the board…");
    await mount();
    expect(mocks.ensureBoard).toHaveBeenCalledTimes(1);
    expect(mocks.ensureBoard).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, projectId: "p1" }),
    );
  });

  it("tells a viewer the project has no board and offers no edits", async () => {
    withBoards();
    mocks.canEdit = false;
    await mount();
    expect(host.textContent).toContain("No board yet");
    expect(mocks.ensureBoard).not.toHaveBeenCalled();
    expect(button("New card")).toBeUndefined();
  });

  it.each([
    ["unavailable", () => (mocks.states = []), "Boards are not available"],
    [
      "failed",
      () => (mocks.states = [{ environmentId, state: null, error: true }]),
      "Could not load the board",
    ],
    [
      "loading",
      () => (mocks.states = [{ environmentId, state: null, error: false }]),
      "Loading board…",
    ],
  ] as const)("shows the %s state", async (_name, arrange, text) => {
    arrange();
    await mount();
    expect(host.textContent).toContain(text);
  });
});
