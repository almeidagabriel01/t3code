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
    alert: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  FlatList: (props: { data: unknown[]; renderItem: (info: unknown) => ReactNode }) =>
    props.data.map((item, index) => props.renderItem({ item, index })),
  Pressable: (props: { accessibilityLabel?: string; children?: ReactNode }) => (
    <button aria-label={props.accessibilityLabel}>{props.children}</button>
  ),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert, prompt: vi.fn() }));
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
vi.mock("./KanbanCardTile", () => ({ KanbanCardTile: () => null }));
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
  kanbanEnvironment: { ensureBoard: "ensureBoard" },
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { openScratch: "openScratch" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "openScratch" ? mocks.openScratch : mocks.ensureBoard,
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
  mocks.alert.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const mount = () => act(async () => root.render(<KanbanBoardRouteScreen />));
const press = (label: string) =>
  act(async () => {
    [...host.querySelectorAll("button")].find((node) => node.textContent === label)?.click();
  });

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
});
