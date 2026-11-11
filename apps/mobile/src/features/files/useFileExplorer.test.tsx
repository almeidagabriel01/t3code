import { ProjectChangeEntryError, type ProjectEntryChange } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  TextInputDialogRequest,
  ConfirmDialogRequest,
} from "../../components/ui/Dialog.types";

const mocks = vi.hoisted(() => ({
  canWrite: true,
  changes: [] as unknown[],
  replies: [] as unknown[],
  prompt: vi.fn(),
  confirm: vi.fn(),
  alert: vi.fn(),
  copy: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.canWrite }));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { changeEntry: { permissionAtom: () => "permission" } },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (value: { input: { change: unknown } }) => {
    mocks.changes.push(value.input.change);
    return mocks.replies.shift() ?? AsyncResult.success({ entries: [], failures: [] });
  },
}));
vi.mock("../../components/ui/Dialog", () => ({
  prompt: mocks.prompt,
  confirm: mocks.confirm,
  alert: mocks.alert,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));

import { fileExplorerMenuActions, useFileExplorer } from "./useFileExplorer";

type Explorer = ReturnType<typeof useFileExplorer>;

function mount(options: { environmentId?: string | null } = {}) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const calls = {
    open: vi.fn(),
    find: vi.fn(),
    refresh: vi.fn(),
    expand: vi.fn<(update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void>(),
  };
  const result: { current: Explorer | null } = { current: null };
  function Probe(props: { readonly onRender: (explorer: Explorer) => void }) {
    const explorer = useFileExplorer({
      environmentId: (options.environmentId === undefined ? "env" : options.environmentId) as never,
      cwd: "/repo",
      entries: [
        { path: "src", kind: "directory" },
        { path: "src/a.ts", kind: "file" },
        { path: "src/b.ts", kind: "file" },
      ],
      selectedPath: "src/a.ts",
      setExpandedPaths: calls.expand,
      onOpenFile: calls.open,
      onFindInFolder: calls.find,
      refresh: calls.refresh,
    });
    props.onRender(explorer);
    return null;
  }
  act(() =>
    root.render(
      <Probe
        onRender={(explorer) => {
          result.current = explorer;
        }}
      />,
    ),
  );
  return {
    explorer: () => result.current!,
    calls,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

const lastPrompt = () => mocks.prompt.mock.lastCall?.[0] as TextInputDialogRequest;
const lastConfirm = () => mocks.confirm.mock.lastCall?.[0] as ConfirmDialogRequest;
const settle = () => act(async () => {});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.canWrite = true;
  mocks.changes = [];
  mocks.replies = [];
  mocks.prompt.mockReset();
  mocks.confirm.mockReset();
  mocks.alert.mockReset();
  mocks.copy.mockReset();
});

describe("fileExplorerMenuActions", () => {
  it("lists the phone actions and locks writes without write access", () => {
    expect(
      fileExplorerMenuActions({ kind: "file", path: "a.md", isExpanded: false, canWrite: false }),
    ).toEqual([
      {
        id: "new-file",
        title: "New File",
        image: "doc.badge.plus",
        attributes: { disabled: true },
      },
      {
        id: "new-folder",
        title: "New Folder",
        image: "folder.badge.plus",
        attributes: { disabled: true },
      },
      { id: "copy-path", title: "Copy Path", image: "doc.on.doc" },
      { id: "copy-relative-path", title: "Copy Relative Path", image: "link" },
      {
        id: "duplicate",
        title: "Duplicate",
        image: "plus.square.on.square",
        attributes: { disabled: true },
      },
      { id: "view-file", title: "View File", image: "doc.text" },
      { id: "rename", title: "Rename", image: "pencil", attributes: { disabled: true } },
      {
        id: "delete",
        title: "Delete",
        image: "trash",
        attributes: { disabled: true, destructive: true },
      },
    ]);
    expect(
      fileExplorerMenuActions({ kind: "directory", path: "src", isExpanded: true, canWrite: true })
        .map((action) => action.id)
        .filter((id) => id === "collapse-folder" || id === "find-in-folder"),
    ).toEqual(["collapse-folder", "find-in-folder"]);
  });
});

describe("useFileExplorer", () => {
  it("creates a nested file beside the selection, asking again while the name is unusable", async () => {
    using view = mount();
    const newFile = view.explorer().headerMenu.items[0]!;
    expect(newFile).toMatchObject({ title: "New File", disabled: false });
    act(() => ("onPress" in newFile ? newFile.onPress() : undefined));
    expect(lastPrompt()).toMatchObject({ title: "New File", message: "In src/" });
    lastPrompt().onConfirm(".git/x");
    expect(lastPrompt()).toMatchObject({
      message: "Git metadata cannot be changed here.",
      initialValue: ".git/x",
    });
    lastPrompt().onConfirm("b.ts");
    expect(lastPrompt().message).toBe('"b.ts" already exists.');
    lastPrompt().onConfirm("notes/c.ts");
    await settle();
    expect(mocks.changes).toEqual([
      { _tag: "create", relativePath: "src/notes/c.ts", kind: "file" },
    ]);
    expect(view.calls.open).toHaveBeenCalledWith("src/notes/c.ts");
    expect(view.calls.refresh).toHaveBeenCalledOnce();
    expect([...view.calls.expand.mock.calls[0]![0](new Set())]).toEqual(["src"]);
  });

  it("creates a folder at the root and expands it", async () => {
    using view = mount();
    act(() => view.explorer().rowMenu("src", "directory", false).onPressAction("new-folder"));
    expect(lastPrompt().message).toBe("In src/");
    lastPrompt().onConfirm("lib/");
    await settle();
    expect(mocks.changes).toEqual([{ _tag: "create", relativePath: "src/lib", kind: "directory" }]);
    expect(view.calls.open).not.toHaveBeenCalled();
    expect(view.calls.expand.mock.calls.map(([update]) => [...update(new Set())])).toEqual([
      ["src"],
      ["src/lib"],
    ]);
  });

  it("renames in place and ignores an unchanged name", async () => {
    using view = mount();
    const menu = view.explorer().rowMenu("src/a.ts", "file", false);
    act(() => menu.onPressAction("rename"));
    expect(lastPrompt()).toMatchObject({ title: "Rename", initialValue: "a.ts" });
    lastPrompt().onConfirm("a.ts");
    lastPrompt().onConfirm("b/c.ts");
    expect(lastPrompt().message).toBe('Names cannot contain "/".');
    lastPrompt().onConfirm("z.ts");
    await settle();
    expect(mocks.changes).toEqual([
      { _tag: "move", relativePath: "src/a.ts", newRelativePath: "src/z.ts" },
    ]);
  });

  it("trashes after confirming and offers a permanent delete when there is no Trash", async () => {
    mocks.replies = [
      AsyncResult.failure(
        Cause.fail(
          new ProjectChangeEntryError({ failure: "trash_unavailable", message: "No Trash here." }),
        ),
      ),
    ];
    using view = mount();
    act(() => view.explorer().rowMenu("src/a.ts", "file", false).onPressAction("delete"));
    expect(lastConfirm()).toMatchObject({ title: "Move “a.ts” to the Trash?", destructive: true });
    lastConfirm().onConfirm();
    await settle();
    expect(lastConfirm()).toMatchObject({
      title: "Delete “a.ts” permanently?",
      message: "No Trash here. This cannot be undone.",
    });
    lastConfirm().onConfirm();
    await settle();
    expect(mocks.changes).toEqual([
      { _tag: "delete", relativePaths: ["src/a.ts"], mode: "trash" },
      { _tag: "delete", relativePaths: ["src/a.ts"], mode: "permanent" },
    ]);
  });

  it("reports a failed delete and per-item failures", async () => {
    mocks.replies = [
      AsyncResult.failure(
        Cause.fail(new ProjectChangeEntryError({ failure: "not_found", message: "Gone." })),
      ),
      AsyncResult.success({
        entries: [],
        failures: [{ relativePath: "src", message: "Permission denied" }],
      }),
      AsyncResult.success({
        entries: [],
        failures: [
          { relativePath: "a", message: "Busy" },
          { relativePath: "b", message: "Busy" },
        ],
      }),
    ];
    using view = mount();
    act(() => view.explorer().rowMenu("src/a.ts", "file", false).onPressAction("delete"));
    lastConfirm().onConfirm();
    await settle();
    expect(mocks.alert).toHaveBeenLastCalledWith("Couldn't delete the file", "Gone.");
    act(() => view.explorer().rowMenu("src", "directory", false).onPressAction("duplicate"));
    await settle();
    expect(mocks.alert).toHaveBeenLastCalledWith("Couldn't change src", "Permission denied");
    act(() => view.explorer().rowMenu("src", "directory", false).onPressAction("duplicate"));
    await settle();
    expect(mocks.alert).toHaveBeenLastCalledWith("Some items were not changed", "Busy");
    expect((mocks.changes as ProjectEntryChange[]).map((change) => change._tag)).toEqual([
      "delete",
      "duplicate",
      "duplicate",
    ]);
  });

  it("copies paths, opens, collapses and scopes search", () => {
    using view = mount();
    const file = view.explorer().rowMenu("src/a.ts", "file", false);
    const folder = view.explorer().rowMenu("src", "directory", true);
    file.onPressAction("copy-path");
    file.onPressAction("copy-relative-path");
    expect(mocks.copy.mock.calls).toEqual([["/repo/src/a.ts"], ["src/a.ts"]]);
    file.onPressAction("view-file");
    expect(view.calls.open).toHaveBeenCalledWith("src/a.ts");
    folder.onPressAction("find-in-folder");
    expect(view.calls.find).toHaveBeenCalledWith("src");
    folder.onPressAction("collapse-folder");
    const update = view.calls.expand.mock.lastCall![0];
    expect([...update(new Set(["src", "src/x", "srcx", "lib"]))]).toEqual(["srcx", "lib"]);
  });

  it("locks writes without an environment and reports when a change cannot be sent", async () => {
    mocks.canWrite = true;
    using view = mount({ environmentId: null });
    expect(
      view.explorer().headerMenu.items.every((item) => "disabled" in item && item.disabled),
    ).toBe(true);
    act(() => view.explorer().rowMenu("src", "directory", false).onPressAction("duplicate"));
    await settle();
    expect(mocks.alert).toHaveBeenLastCalledWith(
      "Couldn't change the file",
      "Reconnect and try again.",
    );
    expect(mocks.changes).toEqual([]);
  });
});
