import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    states: [] as unknown[],
    projects: [] as unknown[],
    scratchRoot: "/data/scratch" as string | null,
    openScratch: vi.fn(),
    ensureBoard: vi.fn(),
    createCard: vi.fn(),
    prompt: vi.fn(),
    alert: vi.fn(),
    navigate: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: (props: {
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    style?: { width?: number };
    children?: ReactNode;
  }) => (
    <div
      data-width={props.style?.width}
      ref={() => props.onLayout?.({ nativeEvent: { layout: { width: 600 } } })}
    >
      {props.children}
    </div>
  ),
  FlatList: (props: { data: unknown[]; renderItem: (info: unknown) => ReactNode }) =>
    props.data.map((item, index) => props.renderItem({ item, index })),
  Pressable: (props: { accessibilityLabel?: string; children?: ReactNode }) => (
    <button aria-label={props.accessibilityLabel}>{props.children}</button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert, prompt: mocks.prompt }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string }) => <span>{props.label}</span>,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string; action?: ReactNode }) => (
    <>
      {props.title}
      {props.action}
    </>
  ),
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
          {action.title}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "00000000-0000-4000-8000-000000000001" }));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("./KanbanCardTile", () => ({
  KanbanCardTile: (props: { card: { id: string }; projectLabel?: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{`tile ${props.card.id} ${props.projectLabel ?? ""}`}</button>
  ),
}));
vi.mock("./KanbanCardMenu", () => ({
  KanbanCardMenu: (props: { card: { id: string }; onOpen: () => void; children?: ReactNode }) => (
    <>
      <button onClick={props.onOpen}>{`menu ${props.card.id}`}</button>
      {props.children}
    </>
  ),
}));
vi.mock("./useKanbanActions", () => ({
  useKanbanActions: () => ({ canEdit: false, createCard: vi.fn() }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  useServerConfigs: () =>
    new Map([["env", { scratchWorkspaceRoot: mocks.scratchRoot }]]) as ReadonlyMap<string, unknown>,
}));
vi.mock("../../state/kanban", () => ({
  useKanbanStates: () => mocks.states,
  kanbanEnvironment: { ensureBoard: "ensureBoard", createCard: "createCard" },
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { openScratch: "openScratch" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    ({
      openScratch: mocks.openScratch,
      ensureBoard: mocks.ensureBoard,
      createCard: mocks.createCard,
    })[command],
}));

import { KanbanBoardRouteScreen } from "./KanbanBoardRouteScreen";

const environmentId = "env" as EnvironmentId;
const scratchProject = {
  environmentId,
  id: "s1",
  title: "Renamed",
  workspaceRoot: "/data/scratch",
};

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.states = [{ environmentId, state: { boards: new Map() }, error: false }];
  mocks.projects = [
    scratchProject,
    { environmentId, id: "p1", title: "Alpha", workspaceRoot: "/w" },
  ];
  mocks.scratchRoot = "/data/scratch";
  mocks.openScratch.mockReset().mockResolvedValue(AsyncResult.success({ id: "s1" }));
  mocks.ensureBoard.mockReset().mockResolvedValue(AsyncResult.success({ boardId: "b1" }));
  mocks.createCard.mockReset().mockResolvedValue(AsyncResult.success({ cardId: "c1" }));
  mocks.prompt.mockReset();
  mocks.alert.mockReset();
  mocks.navigate.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const mount = (scope?: string) =>
  act(async () =>
    root.render(
      <KanbanBoardRouteScreen route={{ params: scope ? { scope } : undefined } as never} />,
    ),
  );
const press = (label: string, which: "first" | "last" = "first") =>
  act(async () => {
    const matches = [...host.querySelectorAll("button")].filter(
      (node) => node.textContent === label,
    );
    (which === "first" ? matches[0] : matches.at(-1))?.click();
  });
const withBoard = () => {
  mocks.projects = [
    ...(mocks.projects as unknown[]),
    { environmentId, id: "p2", title: "Beta", workspaceRoot: "/b" },
  ];
  mocks.states = [
    {
      environmentId,
      state: {
        boards: new Map([
          ["b0", { id: "b0", projectId: "p1", columns: [], cards: new Map(), templates: [] }],
        ]),
      },
      error: false,
    },
  ];
};

describe("KanbanBoardRouteScreen", () => {
  it("creates the No-project board from an empty list: ensures the folder, then the board", async () => {
    await mount();
    expect(host.textContent).toContain("No boards yet");
    expect(host.textContent).not.toContain("Renamed");
    await press("No project");
    expect(mocks.openScratch).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(mocks.ensureBoard).toHaveBeenCalledWith({
      environmentId,
      input: { commandId: expect.any(String), projectId: "s1" },
    });
  });

  it("creates any project's board the same way, without touching the scratch folder", async () => {
    await mount();
    await press("Alpha");
    expect(mocks.openScratch).not.toHaveBeenCalled();
    expect(mocks.ensureBoard).toHaveBeenCalledWith({
      environmentId,
      input: { commandId: expect.any(String), projectId: "p1" },
    });
  });

  it("explains why the board was not created when the folder is unavailable", async () => {
    mocks.openScratch.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("No folder."))));
    await mount();
    await press("No project");
    expect(mocks.alert).toHaveBeenCalledWith("Could not create the board", "No folder.");
    expect(mocks.ensureBoard).not.toHaveBeenCalled();
  });

  it("sizes column pages to the measured content width, not the scroll view", async () => {
    mocks.states = [
      {
        environmentId,
        state: {
          boards: new Map([
            ["b1", { id: "b1", projectId: "p1", columns: [], cards: new Map(), templates: [] }],
          ]),
        },
        error: false,
      },
    ];
    await mount();
    expect(host.querySelector("[data-width]")?.getAttribute("data-width")).toBe("600");
  });

  it("offers no No project entry where the server has no such folder", async () => {
    mocks.scratchRoot = null;
    await mount();
    expect(host.textContent).not.toContain("No project");
  });

  it("names the Scratch board No project in the project chooser", async () => {
    mocks.states = [
      {
        environmentId,
        state: {
          boards: new Map([
            ["b1", { id: "b1", projectId: "s1", columns: [], cards: new Map(), templates: [] }],
          ]),
        },
        error: false,
      },
    ];
    await mount();
    expect(host.textContent).toContain("No project");
    expect(host.textContent).not.toContain("Renamed");
  });

  it("adds a card from the all-projects board: ensures the chosen project's board, then creates the card", async () => {
    withBoard();
    await mount();
    await press("Beta", "last");
    expect(mocks.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ title: "New card", message: "Beta" }),
    );
    await act(async () => mocks.prompt.mock.calls[0]![0].onConfirm("  Fix it  "));
    expect(mocks.ensureBoard).toHaveBeenCalledWith({
      environmentId,
      input: { commandId: expect.any(String), projectId: "p2" },
    });
    expect(mocks.createCard).toHaveBeenCalledWith({
      environmentId,
      input: { commandId: expect.any(String), boardId: "b1", title: "Fix it" },
    });
  });

  it("creates nothing for a blank title or when the board cannot be ensured", async () => {
    withBoard();
    await mount();
    await press("Beta", "last");
    await act(async () => mocks.prompt.mock.calls[0]![0].onConfirm("   "));
    expect(mocks.ensureBoard).not.toHaveBeenCalled();
    mocks.ensureBoard.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("no"))));
    await act(async () => mocks.prompt.mock.calls[0]![0].onConfirm("Title"));
    expect(mocks.createCard).not.toHaveBeenCalled();
  });

  it("offers New card only on the all-projects board", async () => {
    withBoard();
    await mount();
    expect(host.textContent).toContain("New card");
    await press("Alpha");
    expect(host.textContent).not.toContain("New card");
  });

  it("opens on the project a thread's board passes in", async () => {
    withBoard();
    await mount("env:p1");
    expect(host.textContent).not.toContain("New card");
  });

  it("opens a card from its tile and its menu, labelled with its project on the merged board", async () => {
    mocks.states = [
      {
        environmentId,
        state: {
          boards: new Map([
            [
              "b0",
              {
                id: "b0",
                projectId: "p1",
                columns: [
                  {
                    id: "todo",
                    boardId: "b0",
                    name: "Todo",
                    color: null,
                    orderKey: "a",
                    wipLimit: null,
                    role: "todo",
                  },
                ],
                cards: new Map([
                  [
                    "c1",
                    {
                      id: "c1",
                      boardId: "b0",
                      columnId: "todo",
                      orderKey: "a",
                      number: 1,
                      title: "One",
                    },
                  ],
                ]),
                labels: [],
                templates: [],
              },
            ],
          ]),
        },
        error: false,
      },
    ];
    await mount();
    expect(host.textContent).toContain("tile c1 Alpha");
    await press("tile c1 Alpha");
    await press("menu c1");
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsKanbanCard", {
      environmentId,
      cardId: "c1",
    });
  });
});
