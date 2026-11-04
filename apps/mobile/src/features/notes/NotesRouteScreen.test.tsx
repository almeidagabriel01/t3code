import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    projects: [] as unknown[],
    notes: [] as unknown[],
    navigate: vi.fn(),
    canAct: false,
    commands: new Map<unknown, ReturnType<typeof vi.fn>>(),
  },
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
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => mocks.commands.get(command) ?? vi.fn(),
}));
vi.mock("../../state/notes", () => {
  const permission = () => ({ permissionAtom: () => "perm" });
  return {
    notesEnvironment: {
      update: permission(),
      move: permission(),
      delete: permission(),
      startWork: permission(),
      read: permission(),
      write: permission(),
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
  useNoteDraftAccess: () => ({ canEdit: true, canAct: mocks.canAct, connected: true }),
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
  mocks.canAct = false;
  mocks.commands.clear();
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

  describe("row rename", () => {
    const arrange = async () => {
      const { notesEnvironment } = await import("../../state/notes");
      const Dialog = await import("../../components/ui/Dialog");
      const read = vi
        .fn()
        .mockResolvedValue(
          AsyncResult.success({ ...note("one.md", "one", "p1"), body: "# one\nbody" }),
        );
      const write = vi
        .fn()
        .mockResolvedValue(
          AsyncResult.success({ ...note("one.md", "Plan", "p1"), revision: "r3" }),
        );
      const move = vi
        .fn()
        .mockResolvedValue(AsyncResult.success({ ...note("Plan.md", "Plan", "p1") }));
      mocks.commands.set(notesEnvironment.read, read);
      mocks.commands.set(notesEnvironment.write, write);
      mocks.commands.set(notesEnvironment.move, move);
      mocks.canAct = true;
      await mount();
      const prompt = vi.mocked(Dialog.prompt);
      prompt.mockReset();
      await choose("Rename");
      return { read, write, move, prompt, alert: vi.mocked(Dialog.alert) };
    };

    it("rewrites the first line from the latest body and moves the file after its title", async () => {
      const { read, write, move, prompt } = await arrange();
      const options = prompt.mock.calls[0]![0];
      expect(options.initialValue).toBe("Groceries");
      await act(async () => options.onConfirm("Plan"));
      expect(read).toHaveBeenCalledWith({ environmentId, input: { path: "one.md" } });
      expect(write).toHaveBeenCalledWith({
        environmentId,
        input: { path: "one.md", body: "# Plan\nbody", baseRevision: "r" },
      });
      expect(move).toHaveBeenCalledWith({
        environmentId,
        input: { from: "one.md", to: "Plan.md", baseRevision: "r3" },
      });
    });

    it("ignores an empty or unchanged title", async () => {
      const { read, prompt } = await arrange();
      await act(async () => prompt.mock.calls[0]![0].onConfirm("   "));
      await act(async () => prompt.mock.calls[0]![0].onConfirm("Groceries"));
      expect(read).not.toHaveBeenCalled();
    });

    it("alerts when the read or the write fails, and leaves the file alone", async () => {
      const { read, write, move, prompt, alert } = await arrange();
      read.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
      await act(async () => prompt.mock.calls[0]![0].onConfirm("Plan"));
      write.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("conflict"))));
      await act(async () => prompt.mock.calls[0]![0].onConfirm("Plan"));
      expect(alert).toHaveBeenCalledTimes(2);
      expect(move).not.toHaveBeenCalled();
    });

    it("keeps the file name when the move is refused", async () => {
      const { move, prompt, alert } = await arrange();
      move.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("denied"))));
      await act(async () => prompt.mock.calls[0]![0].onConfirm("Plan"));
      expect(move).toHaveBeenCalledOnce();
      expect(alert).not.toHaveBeenCalled();
    });
  });
});
