import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: { projects: [] as unknown[], notes: [] as unknown[], navigate: vi.fn() },
}));

vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: { accessibilityLabel?: string; children?: ReactNode }) => (
    <button aria-label={props.accessibilityLabel}>{props.children}</button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({
  alert: vi.fn(),
  prompt: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/NavigationRow", () => ({
  NavigationRow: (props: { title: string; onPress: () => void }) => (
    <button data-row onClick={props.onPress}>
      {props.title}
    </button>
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
          data-action={action.title}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/SearchField", () => ({
  SearchField: (props: { accessibilityLabel: string; onChangeText: (value: string) => void }) => (
    <input
      aria-label={props.accessibilityLabel}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../state/workspace", () => ({ useWorkspaceEnvironments: () => [] }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/notes", () => {
  const permission = { permissionAtom: () => "perm" };
  return {
    notesEnvironment: {
      update: permission,
      move: permission,
      delete: permission,
      startWork: permission,
    },
    useNotesEnvironmentIds: () => ["env"],
    useNotesFeed: () =>
      AsyncResult.success({
        notes: new Map((mocks.notes as { path: string }[]).map((note) => [note.path, note])),
        truncated: false,
        omitted: 0,
        skipped: [],
      }),
  };
});
vi.mock("./notes-state", () => ({
  notesCommandOptions: {},
  useNoteDraftAccess: () => ({ canEdit: true, canAct: false, connected: true }),
  useNotesOutbox: () => [],
}));

import { NotesRouteScreen } from "./NotesRouteScreen";

const environmentId = "env" as EnvironmentId;
const project = (id: string, title: string, workspaceRoot: string) => ({
  environmentId,
  id,
  title,
  workspaceRoot,
});
const note = (path: string, title: string, projectId?: string) => ({
  path,
  title,
  folder: null,
  pinned: false,
  preview: "",
  project: projectId,
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: "r",
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.navigate.mockReset();
  mocks.projects = [
    project("p1", "app", "/work/a/app"),
    project("p2", "app", "/work/b/app"),
    project("p3", "Solo", "/work/solo"),
  ];
  mocks.notes = [
    note("one.md", "Groceries", "p1"),
    note("two.md", "Roadmap", "p2"),
    note("three.md", "Roadmap ideas"),
  ];
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const mount = (params?: { environmentId: EnvironmentId; project?: string }) =>
  act(async () => root.render(<NotesRouteScreen route={{ params } as never} />));
const rows = () => [...host.querySelectorAll("[data-row]")].map((node) => node.textContent);
const type = (value: string) =>
  act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const choose = (title: string) =>
  act(async () => host.querySelector<HTMLElement>(`[data-action="${title}"]`)?.click());

describe("NotesRouteScreen", () => {
  it("labels projects that share a title by their folder, and keeps unique titles", async () => {
    await mount();
    const titles = [...host.querySelectorAll("[data-action]")].map((node) => node.textContent);
    expect(titles).toEqual(["All projects", "app · a", "app · b", "Solo"]);
  });

  it("filters by project, from the picker and from the route's project", async () => {
    await mount();
    expect(rows()).toHaveLength(3);
    await choose("app · b");
    expect(rows()).toEqual(["Roadmap"]);
    await choose("All projects");
    expect(rows()).toHaveLength(3);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount({ environmentId, project: "p1" });
    expect(rows()).toEqual(["Groceries"]);
  });

  it("searches within the chosen project and says when nothing matches", async () => {
    await mount();
    await type("roadmap");
    expect(rows().sort()).toEqual(["Roadmap", "Roadmap ideas"]);
    await choose("app · a");
    expect(host.textContent).toContain("No notes match");
    expect(rows()).toEqual([]);
  });

  it("opens a note on press", async () => {
    await mount();
    await act(async () => host.querySelector<HTMLElement>("[data-row]")?.click());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsNote", {
      environmentId,
      path: expect.stringMatching(/\.md$/),
    });
  });
});
