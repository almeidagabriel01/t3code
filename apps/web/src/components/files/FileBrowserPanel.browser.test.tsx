import {
  EnvironmentId,
  ProjectChangeEntryError,
  type ProjectChangeEntryResult,
  type ProjectEntry,
  type ProjectEntryChange,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { dismissContextMenu } from "~/contextMenuFallback";
import { readLocalApi } from "~/localApi";
import { render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
  { path: ".env", kind: "file" },
  { path: "index.html", kind: "file" },
];
const loadingDirectories: ReadonlySet<string> = new Set();
const directory = {
  entries,
  load: () => Promise.resolve(),
  refresh: () => {},
  ready: true,
  error: null,
  isPending: false,
  loadingDirectories,
};
const pathSearch = {
  entries: [],
  isPending: false,
  error: null,
  truncated: false,
  refresh: () => {},
};

vi.mock("./useDirectoryEntries", () => ({ useDirectoryEntries: () => directory }));
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => pathSearch }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({
    buildItems: () => [
      {
        id: "open-with",
        label: "Open with",
        children: server.editorIds.map((id) => ({ id: `editor:${id}`, label: id })),
      },
    ],
    activate: server.activate,
    capabilities: {
      canOpenDefault: false,
      editorIds: server.editorIds,
      revealLabel: server.editorIds.length > 0 ? "Reveal in Finder" : undefined,
    },
  }),
}));

type ChangeReply = ProjectChangeEntryResult | ProjectChangeEntryError;
const isChangeEntryError = Schema.is(ProjectChangeEntryError);
const server = vi.hoisted(() => ({
  writable: true,
  changes: [] as ProjectEntryChange[],
  replies: [] as unknown[],
  editorIds: [] as string[],
  activate: (..._args: unknown[]) => Promise.resolve(),
}));
const permission = { writable: Atom.make(true), readOnly: Atom.make(false) };
vi.mock("~/state/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/projects")>();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      changeEntry: {
        permissionAtom: () => (server.writable ? permission.writable : permission.readOnly),
      },
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async ({ input }: { input: { change: ProjectEntryChange } }) => {
      server.changes.push(input.change);
      const reply = (server.replies.shift() as ChangeReply | undefined) ?? {
        entries: [],
        failures: [],
      };
      return isChangeEntryError(reply)
        ? AsyncResult.failure(Cause.fail(reply))
        : AsyncResult.success(reply);
    },
}));

/** Resets the fake server; each reply answers one change in order, then empty successes. */
function setup(
  options: {
    writable?: boolean;
    replies?: ChangeReply[];
    editorIds?: string[];
    activate?: (...args: unknown[]) => Promise<void>;
  } = {},
) {
  server.writable = options.writable ?? true;
  server.changes = [];
  server.replies = [...(options.replies ?? [])];
  server.editorIds = options.editorIds ?? [];
  server.activate = options.activate ?? (() => Promise.resolve());
}

const renderPanel = (
  onOpenFile: (path: string) => void = () => {},
  extra: Partial<Parameters<typeof FileBrowserPanel>[0]> = {},
) =>
  render(
    <FileBrowserPanel
      environmentId={EnvironmentId.make("env-files")}
      cwd="/repo"
      projectName="repo"
      selectedPath={null}
      selectedPathRevealId={0}
      onOpenFile={onOpenFile}
      workspaceMutationId={null}
      {...extra}
    />,
  );

async function pick(path: string, name: string | RegExp) {
  await vi.waitFor(() => expect(findTreeRow(path)).not.toBeNull());
  openRowMenu(path);
  const item = page.getByRole(
    "menuitem",
    typeof name === "string" ? { name, exact: true } : { name },
  );
  await expect.element(item).toBeVisible();
  await userEvent.click(item);
}

const failure = (failureKind: ProjectChangeEntryError["failure"], message: string) =>
  new ProjectChangeEntryError({ failure: failureKind, message });

function openRowMenu(path: string) {
  findTreeRow(path)!.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, button: 2 }),
  );
}

function renameInput(): HTMLInputElement | null {
  for (const host of document.querySelectorAll("*")) {
    const input = host.shadowRoot?.querySelector<HTMLInputElement>("[data-item-rename-input]");
    if (input) return input;
  }
  return null;
}

async function typeName(name: string) {
  await vi.waitFor(() => expect(renameInput()).not.toBeNull());
  const input = renameInput()!;
  await vi.waitFor(() => expect(input.getRootNode()).toHaveProperty("activeElement", input));
  await userEvent.keyboard(`${name}{Enter}`);
}
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

describe("FileBrowserPanel", () => {
  it("copies with the pointer and returns to the row after keyboard dismissal", async () => {
    setup();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
      }),
    );
    const action = page.getByRole("menuitem", { name: "Copy Mention", exact: true });
    await expect.element(action).toBeVisible();
    await userEvent.click(action);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("[README.md](README.md)"));

    const row = findTreeRow("README.md")!;
    await userEvent.keyboard("{Tab}");
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(action).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect((row.getRootNode() as ShadowRoot).activeElement).toBe(row));
  });

  it("dragging a file row carries a composer mention without opening it, and dragend releases it", async () => {
    setup();
    const onOpenFile = vi.fn();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;

    const dataTransfer = new DataTransfer();
    row.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );
    // The tree selects the row the drag picked up; mid-drag that must not open it.
    row.click();
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));

    expect(dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toContain("README.md");
    expect(onOpenFile).not.toHaveBeenCalled();

    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, composed: true, dataTransfer }));
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).not.toBe("true"));

    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(1));
  });

  it("groups the row menu and locks write actions without write access", async () => {
    setup({ writable: false });
    await using screen = await renderPanel();
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    openRowMenu("README.md");
    for (const name of ["Copy Path", "Copy Relative Path", "View File"]) {
      await expect.element(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
    }
    // Rename and Delete carry their shortcut in the accessible name.
    for (const name of [/^New File$/, /^Duplicate$/, /^Rename/, /^Delete/]) {
      await expect.element(page.getByRole("menuitem", { name })).toBeDisabled();
    }
    await expect.element(screen.getByRole("button", { name: "New file" })).toBeDisabled();
  });

  it("creates a nested file inline, opens it, and undoes it to the Trash", async () => {
    setup({
      replies: [
        { entries: [{ relativePath: "notes/a.md" }], failures: [] },
        { entries: [{ relativePath: "notes/a.md", restoreToken: "t1" }], failures: [] },
      ],
    });
    const onOpenFile = vi.fn();
    await using screen = await renderPanel(onOpenFile);
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "New file" }));
    await typeName("notes/a.md");
    await vi.waitFor(() =>
      expect(server.changes).toEqual([
        { _tag: "create", relativePath: "notes/a.md", kind: "file" },
      ]),
    );
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("notes/a.md"));

    findTreeRow("README.md")!.focus();
    await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
    await vi.waitFor(() =>
      expect(server.changes.at(-1)).toEqual({
        _tag: "delete",
        relativePaths: ["notes/a.md"],
        mode: "trash",
      }),
    );
    await userEvent.keyboard("{ControlOrMeta>}{Shift>}z{/Shift}{/ControlOrMeta}");
    await vi.waitFor(() =>
      expect(server.changes.at(-1)).toEqual({ _tag: "restore", restoreTokens: ["t1"] }),
    );
  });

  it("shows an invalid name inline without calling the server and keeps the typed name", async () => {
    setup();
    await using screen = await renderPanel();
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "New folder" }));
    await typeName(".git/hooks");
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Git metadata cannot be changed here.");
    await vi.waitFor(() => expect(renameInput()?.value).toBe(".git/hooks"));
    expect(server.changes).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  it("deletes the focused row after confirming and falls back to a permanent delete", async () => {
    setup({
      replies: [
        new ProjectChangeEntryError({
          failure: "trash_unavailable",
          message: "This system has no Trash.",
        }),
      ],
    });
    await using _screen = await renderPanel();
    using confirm = vi.spyOn(readLocalApi()!.dialogs, "confirm").mockResolvedValue(true);
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.focus();
    await userEvent.keyboard("{Delete}");
    await vi.waitFor(() =>
      expect(server.changes).toEqual([
        { _tag: "delete", relativePaths: ["README.md"], mode: "trash" },
        { _tag: "delete", relativePaths: ["README.md"], mode: "permanent" },
      ]),
    );
    expect(confirm.mock.calls.map(([message]) => message.split("\n")[0])).toEqual([
      'Move "README.md" to the Trash?',
      'Delete "README.md" permanently?',
    ]);
  });

  it("duplicates from the menu and reports per-item failures", async () => {
    setup({
      replies: [{ entries: [], failures: [{ relativePath: "src", message: "Permission denied" }] }],
    });
    await using screen = await renderPanel();
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    openRowMenu("src/");
    await userEvent.click(page.getByRole("menuitem", { name: "Duplicate", exact: true }));
    await vi.waitFor(() =>
      expect(server.changes).toEqual([{ _tag: "duplicate", relativePath: "src" }]),
    );
    await expect.element(screen.getByRole("alert")).toHaveTextContent("src: Permission denied");
  });

  it("imports files dropped from Finder into the folder under the pointer", async () => {
    setup();
    await using _screen = await renderPanel();
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["hi"], "note.txt"));
    const folder = findTreeRow("src/")!;
    folder.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );
    folder.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );
    await vi.waitFor(() =>
      expect(server.changes).toEqual([
        { _tag: "import", relativePath: "src/note.txt", contentsBase64: btoa("hi") },
      ]),
    );
  });

  it("toggles dotfiles from the background menu and remembers the choice", async () => {
    setup();
    using _storage = {
      [Symbol.dispose]: () => localStorage.removeItem("t3code.fileExplorerShowDotfiles"),
    };
    await using screen = await renderPanel();
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await vi.waitFor(() => expect(findTreeRow(".env")).not.toBeNull());
    const area = screen.container.querySelector<HTMLElement>("[data-file-tree-area]")!;
    area.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await expect
      .element(page.getByRole("menuitem", { name: "Collapse All", exact: true }))
      .toBeVisible();
    await userEvent.click(page.getByRole("menuitemradio", { name: "Show Dotfiles" }));
    await vi.waitFor(() => expect(findTreeRow(".env")).toBeNull());
    expect(localStorage.getItem("t3code.fileExplorerShowDotfiles")).toBe("false");
    expect(findTreeRow("README.md")).not.toBeNull();
    // The header carries the same toggle for trees with no empty space to right-click.
    await userEvent.click(screen.getByRole("button", { name: "Show dotfiles" }));
    await vi.waitFor(() => expect(findTreeRow(".env")).not.toBeNull());
    await expect
      .element(screen.getByRole("button", { name: "Hide dotfiles" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("renames the focused row with F2", async () => {
    setup({ replies: [{ entries: [{ relativePath: "DOCS.md" }], failures: [] }] });
    await using _screen = await renderPanel();
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.focus();
    await userEvent.keyboard("{F2}");
    await vi.waitFor(() => expect(renameInput()?.value).toBe("README.md"));
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    await typeName("DOCS.md");
    await vi.waitFor(() =>
      expect(server.changes).toEqual([
        { _tag: "move", relativePath: "README.md", newRelativePath: "DOCS.md" },
      ]),
    );
  });

  it("scopes the search to a folder and copies paths", async () => {
    setup();
    await using screen = await renderPanel();
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    openRowMenu("src/");
    await userEvent.click(page.getByRole("menuitem", { name: "Find in Folder", exact: true }));
    await expect.element(screen.getByText("Searching in src/")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Search all files" }));
    await expect.element(screen.getByText("Searching in src/")).not.toBeInTheDocument();

    openRowMenu("README.md");
    await userEvent.click(page.getByRole("menuitem", { name: "Copy Path", exact: true }));
    await vi.waitFor(() => expect(clipboard).toHaveBeenLastCalledWith("/repo/README.md"));
    openRowMenu("README.md");
    await userEvent.click(page.getByRole("menuitem", { name: "Copy Relative Path", exact: true }));
    await vi.waitFor(() => expect(clipboard).toHaveBeenLastCalledWith("README.md"));
  });

  it("runs the host's folder and file actions from the menu", async () => {
    setup({ editorIds: ["vscode"] });
    const hostActions = {
      openInTerminal: vi.fn(),
      addAsProject: vi.fn(),
      openInBrowser: vi.fn(),
      openMarkdownPreview: vi.fn(),
    };
    const activate = vi.fn((..._args: unknown[]) => Promise.resolve());
    server.activate = activate;
    await using _screen = await renderPanel(() => {}, { hostActions });
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await pick("src/", "Open in Terminal");
    expect(hostActions.openInTerminal).toHaveBeenCalledWith("/repo/src");
    await pick("src/", "Add as Project…");
    expect(hostActions.addAsProject).toHaveBeenCalledWith("/repo/src");
    await pick("index.html", "Open in Browser");
    expect(hostActions.openInBrowser).toHaveBeenCalledWith("index.html");
    await pick("README.md", "Open Markdown Preview");
    expect(hostActions.openMarkdownPreview).toHaveBeenCalledWith("README.md");
    await pick("README.md", "Reveal in Finder");
    await vi.waitFor(() =>
      expect(activate).toHaveBeenCalledWith(
        "reveal-in-folder",
        expect.objectContaining({ filePath: "README.md" }),
      ),
    );
    openRowMenu("README.md");
    await userEvent.click(page.getByRole("menuitem", { name: "Open in", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "vscode", exact: true }));
    await vi.waitFor(() =>
      expect(activate).toHaveBeenLastCalledWith(
        "editor:vscode",
        expect.objectContaining({ filePath: "README.md" }),
      ),
    );
  });

  it("renames from the menu, retargeting the open file", async () => {
    setup({
      replies: [{ entries: [{ relativePath: "GUIDE.md" }], failures: [] }],
    });
    const onOpenFile = vi.fn();
    await using _screen = await renderPanel(onOpenFile, { selectedPath: "README.md" });
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await pick("README.md", /^Rename/);
    await vi.waitFor(() => expect(renameInput()?.value).toBe("README.md"));
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    await typeName("GUIDE.md");
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("GUIDE.md"));
    expect(server.changes.map((change) => change._tag)).toEqual(["move"]);
  });

  it("asks before deleting from the menu and does nothing when declined", async () => {
    setup();
    await using _screen = await renderPanel();
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using confirm = vi.spyOn(readLocalApi()!.dialogs, "confirm").mockResolvedValue(false);
    await pick("src/", /^Delete/);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(server.changes).toEqual([]);
  });

  it("restores the name and shows the server's reason when a rename fails", async () => {
    setup({ replies: [failure("already_exists", '"src" already exists.')] });
    await using screen = await renderPanel();
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.focus();
    await userEvent.keyboard("{F2}");
    await vi.waitFor(() => expect(renameInput()?.value).toBe("README.md"));
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    await typeName("NOTES.md");
    await expect.element(screen.getByRole("alert")).toHaveTextContent('"src" already exists.');
    await vi.waitFor(() => expect(renameInput()?.value).toBe("NOTES.md"));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
  });

  it("asks again for a rename the explorer refuses before reaching the server", async () => {
    setup();
    await using screen = await renderPanel();
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.focus();
    await userEvent.keyboard("{F2}");
    await vi.waitFor(() => expect(renameInput()?.value).toBe("README.md"));
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    await typeName("~home");
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Use a name inside the project.");
    await userEvent.keyboard("{Escape}");
    findTreeRow("README.md")!.focus();
    await userEvent.keyboard("{F2}");
    await vi.waitFor(() => expect(renameInput()?.value).toBe("README.md"));
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    // The tree itself refuses a name a sibling already has.
    await typeName("src");
    await vi.waitFor(() => expect(renameInput()?.value).toBe("src"));
    expect(server.changes).toEqual([]);
  });

  it("creates in a folder from the menu and recovers when the server refuses", async () => {
    setup({ replies: [failure("operation_failed", "Disk full.")] });
    const onOpenFile = vi.fn();
    await using screen = await renderPanel(onOpenFile);
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await pick("src/", "New File");
    await typeName("x.ts");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Disk full.");
    await vi.waitFor(() => expect(renameInput()?.value).toBe("x.ts"));
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(server.changes).toEqual([
        { _tag: "create", relativePath: "src/x.ts", kind: "file" },
        { _tag: "create", relativePath: "src/x.ts", kind: "file" },
      ]),
    );
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("src/x.ts"));
  });

  it("reports delete, duplicate and undo failures in the explorer", async () => {
    setup({
      replies: [
        failure("not_found", "README.md is gone."),
        failure("operation_failed", "Copy failed."),
      ],
    });
    await using screen = await renderPanel();
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using _confirm = vi.spyOn(readLocalApi()!.dialogs, "confirm").mockResolvedValue(true);
    await pick("README.md", /^Delete/);
    await expect.element(screen.getByRole("alert")).toHaveTextContent("README.md is gone.");
    await pick("README.md", "Duplicate");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Copy failed.");
  });

  it("reports a failed permanent delete after the Trash fallback", async () => {
    setup({
      replies: [failure("trash_unavailable", "No Trash."), failure("operation_failed", "Locked.")],
    });
    await using screen = await renderPanel();
    using _confirm = vi.spyOn(readLocalApi()!.dialogs, "confirm").mockResolvedValue(true);
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.focus();
    await userEvent.keyboard("{ControlOrMeta>}{Backspace}{/ControlOrMeta}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Locked.");
  });

  it("collapses and refreshes from the menus", async () => {
    setup();
    using refresh = vi.spyOn(directory, "refresh");
    await using screen = await renderPanel();
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    findTreeRow("src/")!.click();
    await pick("src/", "Collapse Folder");
    const area = screen.container.querySelector<HTMLElement>("[data-file-tree-area]")!;
    area.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Collapse All", exact: true }));
    area.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Refresh Explorer", exact: true }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("moves rows dropped on a folder and puts the tree back when the move fails", async () => {
    setup({ replies: [{ entries: [], failures: [] }, failure("already_exists", "Taken.")] });
    await using screen = await renderPanel();
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    const drag = (path: string) => {
      const dataTransfer = new DataTransfer();
      const row = findTreeRow(path)!;
      const folder = findTreeRow("src/")!;
      const box = folder.getBoundingClientRect();
      const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer, ...at };
      row.dispatchEvent(new DragEvent("dragstart", init));
      folder.dispatchEvent(new DragEvent("dragover", init));
      folder.dispatchEvent(new DragEvent("drop", init));
      row.dispatchEvent(new DragEvent("dragend", init));
    };
    drag("README.md");
    await vi.waitFor(() =>
      expect(server.changes).toEqual([
        { _tag: "move", relativePath: "README.md", newRelativePath: "src/README.md" },
      ]),
    );
    await vi.waitFor(() => expect(findTreeRow(".env")).not.toBeNull());
    drag(".env");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Taken.");
    await vi.waitFor(() => expect(findTreeRow(".env")).not.toBeNull());
  });

  it("skips dropped files over the import limit", async () => {
    setup();
    await using screen = await renderPanel();
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    const big = new DataTransfer();
    big.items.add(new File([new Uint8Array(25 * 1024 * 1024 + 1)], "huge.bin"));
    const area = screen.container.querySelector<HTMLElement>("[data-file-tree-area]")!;
    area.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: big }),
    );
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent('"huge.bin" is larger than 25 MB and was not added.');
    expect(server.changes).toEqual([]);
  });
});
