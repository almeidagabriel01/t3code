import type { ProjectChangeEntryResult, ProjectEntryChange } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FileChangeHistory,
  type FileExplorerCapabilities,
  fileExplorerBackgroundActions,
  fileExplorerRowActions,
  inverseEntryChange,
  isDotfilePath,
  joinEntryPath,
  newEntryDirectory,
  parentEntryPath,
  topmostEntryPaths,
  validateEntryName,
} from "./fileExplorer.ts";

const ok = (...paths: string[]): ProjectChangeEntryResult => ({
  entries: paths.map((relativePath) => ({ relativePath })),
  failures: [],
});

describe("validateEntryName", () => {
  it.each([
    ["", { allowNested: true }, "Enter a name."],
    ["   ", { allowNested: true }, "Enter a name."],
    ["a\u0007b", { allowNested: true }, "Names cannot contain control characters."],
    ["/etc/x", { allowNested: true }, "Use a name inside the project."],
    ["~/x", { allowNested: true }, "Use a name inside the project."],
    ["a/b", { allowNested: false }, 'Names cannot contain "/".'],
    ["..", { allowNested: true }, 'Names cannot be empty, "." or "..".'],
    ["a/../b", { allowNested: true }, 'Names cannot be empty, "." or "..".'],
    ["a//b", { allowNested: true }, 'Names cannot be empty, "." or "..".'],
    [".git/config", { allowNested: true }, "Git metadata cannot be changed here."],
    ["src/utils/a.ts", { allowNested: true }, null],
    ["folder/", { allowNested: false }, null],
    [" notes.md ", { allowNested: false }, null],
  ] as const)("%j (%j) → %j", (value, options, expected) => {
    expect(validateEntryName(value, options)).toBe(expected);
  });

  it("reports a taken name with the trimmed name", () => {
    expect(
      validateEntryName(" a.ts ", { allowNested: false, taken: (name) => name === "a.ts" }),
    ).toBe('"a.ts" already exists.');
  });
});

describe("paths", () => {
  it("joins, splits and picks the folder for a new entry", () => {
    expect(joinEntryPath("", "a.ts")).toBe("a.ts");
    expect(joinEntryPath("src/", " b/c.ts/ ")).toBe("src/b/c.ts");
    expect(parentEntryPath("src/a.ts")).toBe("src");
    expect(parentEntryPath("a.ts")).toBe("");
    expect(newEntryDirectory({ kind: "directory", path: "src" })).toBe("src");
    expect(newEntryDirectory({ kind: "file", path: "src/a.ts" })).toBe("src");
    expect(topmostEntryPaths(["src/a.ts", "src", "b", "b", "srcx/c"])).toEqual([
      "src",
      "b",
      "srcx/c",
    ]);
    expect(isDotfilePath("src/.env")).toBe(true);
    expect(isDotfilePath(".github/x.yml")).toBe(true);
    expect(isDotfilePath("src/a.ts")).toBe(false);
  });
});

describe("inverseEntryChange", () => {
  it.each<[string, ProjectEntryChange, ProjectChangeEntryResult, ProjectEntryChange | null]>([
    [
      "create goes to the trash",
      { _tag: "create", relativePath: "a.ts", kind: "file" },
      ok("a.ts"),
      { _tag: "delete", relativePaths: ["a.ts"], mode: "trash" },
    ],
    [
      "import uses the name the server picked",
      { _tag: "import", relativePath: "a.png", contentsBase64: "" },
      ok("a copy.png"),
      { _tag: "delete", relativePaths: ["a copy.png"], mode: "trash" },
    ],
    [
      "duplicate",
      { _tag: "duplicate", relativePath: "a.ts" },
      ok("a copy.ts"),
      { _tag: "delete", relativePaths: ["a copy.ts"], mode: "trash" },
    ],
    [
      "restore",
      { _tag: "restore", restoreTokens: ["t"] },
      ok("a.ts"),
      { _tag: "delete", relativePaths: ["a.ts"], mode: "trash" },
    ],
    ["nothing restored", { _tag: "restore", restoreTokens: ["t"] }, ok(), null],
    [
      "move back",
      { _tag: "move", relativePath: "a.ts", newRelativePath: "b/a.ts" },
      ok("b/a.ts"),
      { _tag: "move", relativePath: "b/a.ts", newRelativePath: "a.ts" },
    ],
    [
      "a move onto itself",
      { _tag: "move", relativePath: "a.ts", newRelativePath: "a.ts" },
      ok("a.ts"),
      null,
    ],
    [
      "trashed delete restores",
      { _tag: "delete", relativePaths: ["a", "b"], mode: "trash" },
      {
        entries: [
          { relativePath: "a", restoreToken: "1" },
          { relativePath: "b", restoreToken: "2" },
        ],
        failures: [],
      },
      { _tag: "restore", restoreTokens: ["1", "2"] },
    ],
    [
      "permanent delete",
      { _tag: "delete", relativePaths: ["a"], mode: "permanent" },
      ok("a"),
      null,
    ],
  ])("%s", (_name, change, result, expected) => {
    expect(inverseEntryChange(change, result)).toEqual(expected);
  });
});

describe("FileChangeHistory", () => {
  it("undoes and redoes a step in reverse order and clears redo on a new action", async () => {
    const history = new FileChangeHistory();
    const ran: ProjectEntryChange[] = [];
    let token = 0;
    const run = async (change: ProjectEntryChange): Promise<ProjectChangeEntryResult> => {
      ran.push(change);
      if (change._tag === "delete") {
        return {
          entries: change.relativePaths.map((relativePath) => ({
            relativePath,
            restoreToken: `t${++token}`,
          })),
          failures: [],
        };
      }
      if (change._tag === "move") return ok(change.newRelativePath);
      return ok("restored.ts");
    };
    expect(await history.undo(run)).toBe(false);
    history.record([
      { change: { _tag: "move", relativePath: "a", newRelativePath: "d/a" }, result: ok("d/a") },
      { change: { _tag: "move", relativePath: "b", newRelativePath: "d/b" }, result: ok("d/b") },
      { change: { _tag: "delete", relativePaths: ["x"], mode: "permanent" }, result: ok("x") },
    ]);
    expect(history.canUndo).toBe(true);
    expect(await history.undo(run)).toBe(true);
    expect(ran).toEqual([
      { _tag: "move", relativePath: "d/b", newRelativePath: "b" },
      { _tag: "move", relativePath: "d/a", newRelativePath: "a" },
    ]);
    expect(history.canRedo).toBe(true);
    ran.length = 0;
    await history.redo(run);
    expect(ran).toEqual([
      { _tag: "move", relativePath: "a", newRelativePath: "d/a" },
      { _tag: "move", relativePath: "b", newRelativePath: "d/b" },
    ]);
    await history.undo(run);
    history.record([
      { change: { _tag: "create", relativePath: "n.ts", kind: "file" }, result: ok("n.ts") },
    ]);
    expect(history.canRedo).toBe(false);
    // Undoing a create trashes it, and redo puts the trashed entry back.
    ran.length = 0;
    await history.undo(run);
    await history.redo(run);
    expect(ran).toEqual([
      { _tag: "delete", relativePaths: ["n.ts"], mode: "trash" },
      { _tag: "restore", restoreTokens: ["t1"] },
    ]);
  });

  it("drops a step that fails and ignores actions with nothing to undo", async () => {
    const history = new FileChangeHistory();
    history.record([
      { change: { _tag: "delete", relativePaths: ["x"], mode: "permanent" }, result: ok("x") },
    ]);
    expect(history.canUndo).toBe(false);
    history.record([
      { change: { _tag: "create", relativePath: "a", kind: "file" }, result: ok("a") },
    ]);
    await expect(
      history.undo(async () => {
        throw new Error("gone");
      }),
    ).rejects.toThrow("gone");
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);

    // A restore whose trashed item is gone reports a failure, not an error: the undo must say so.
    history.record([
      {
        change: { _tag: "delete", relativePaths: ["t"], mode: "trash" },
        result: { entries: [{ relativePath: "t", restoreToken: "r1" }], failures: [] },
      },
    ]);
    await expect(
      history.undo(async () => ({
        entries: [],
        failures: [{ relativePath: "t", message: "It is no longer in the Trash." }],
      })),
    ).rejects.toThrow("t: It is no longer in the Trash.");
    expect(history.canRedo).toBe(false);

    // What a step changed before it failed can still be redone.
    history.record([
      { change: { _tag: "move", relativePath: "a", newRelativePath: "d/a" }, result: ok("d/a") },
      { change: { _tag: "move", relativePath: "b", newRelativePath: "d/b" }, result: ok("d/b") },
    ]);
    await expect(
      history.undo(async (change) => {
        if (change._tag === "move" && change.relativePath === "d/a") throw new Error("busy");
        return ok("b");
      }),
    ).rejects.toThrow("busy");
    const redone: ProjectEntryChange[] = [];
    expect(
      await history.redo(async (change) => {
        redone.push(change);
        return ok("d/b");
      }),
    ).toBe(true);
    expect(redone).toEqual([{ _tag: "move", relativePath: "b", newRelativePath: "d/b" }]);
  });
});

const capabilities: FileExplorerCapabilities = {
  canWrite: true,
  copyFile: true,
  addAsProject: true,
  openInTerminal: true,
  openInBrowser: true,
  markdownPreview: true,
  download: true,
  downloadFolder: true,
  findInFolder: true,
  openIn: true,
  revealLabel: "Reveal in Finder",
  isMac: true,
};

const ids = (groups: ReturnType<typeof fileExplorerRowActions>) =>
  groups.map((group) => group.map((action) => action.id));

describe("fileExplorerRowActions", () => {
  it("groups file actions like Orca and shows markdown preview for markdown only", () => {
    const groups = fileExplorerRowActions({
      kind: "file",
      path: "docs/a.md",
      isExpanded: false,
      selectionSize: 1,
      capabilities,
    });
    expect(ids(groups)).toEqual([
      ["new-file", "new-folder"],
      ["copy-file", "copy-path", "copy-relative-path", "duplicate"],
      ["view-file", "open-in-browser", "open-markdown-preview", "download"],
      ["open-in", "reveal"],
      ["rename", "delete"],
    ]);
    expect(groups.at(-1)).toEqual([
      { id: "rename", label: "Rename", disabled: false, shortcut: "↩" },
      { id: "delete", label: "Delete", destructive: true, disabled: false, shortcut: "⌘⌫" },
    ]);
    expect(
      ids(
        fileExplorerRowActions({
          kind: "file",
          path: "docs/a.md",
          isExpanded: false,
          selectionSize: 1,
          capabilities: { ...capabilities, markdownPreview: false },
        }),
      )[2],
    ).toEqual(["view-file", "open-in-browser", "download"]);
  });

  it("shows folder actions, hides what the host cannot do and locks writes", () => {
    const groups = fileExplorerRowActions({
      kind: "directory",
      path: "src",
      isExpanded: true,
      selectionSize: 1,
      capabilities: {
        ...capabilities,
        canWrite: false,
        downloadFolder: false,
        revealLabel: undefined,
        openIn: false,
        isMac: false,
      },
    });
    expect(ids(groups)).toEqual([
      ["new-file", "new-folder"],
      ["copy-path", "copy-relative-path", "duplicate"],
      ["add-as-project", "open-in-terminal"],
      ["collapse-folder", "find-in-folder"],
      ["rename", "delete"],
    ]);
    expect(
      groups
        .flat()
        .filter((action) => action.disabled)
        .map((action) => action.id),
    ).toEqual(["new-file", "new-folder", "duplicate", "rename", "delete"]);
    expect(groups.at(-1)?.map((action) => action.shortcut)).toEqual(["F2", "Del"]);
    expect(
      ids(
        fileExplorerRowActions({
          kind: "directory",
          path: "src",
          isExpanded: false,
          selectionSize: 1,
          capabilities,
        }),
      )[2],
    ).toEqual(["add-as-project", "open-in-terminal", "download"]);
  });

  it("offers only batch actions for a multi-selection", () => {
    const groups = fileExplorerRowActions({
      kind: "file",
      path: "a.ts",
      isExpanded: false,
      selectionSize: 3,
      capabilities,
    });
    expect(groups.flat().map((action) => action.label)).toEqual([
      "Copy Paths",
      "Copy Relative Paths",
      "Delete",
    ]);
  });
});

describe("fileExplorerBackgroundActions", () => {
  it("lists creation, tree actions and the dotfile toggle", () => {
    const groups = fileExplorerBackgroundActions({ canWrite: false, showDotfiles: true });
    expect(ids(groups)).toEqual([
      ["new-file", "new-folder"],
      ["collapse-all", "refresh"],
      ["toggle-dotfiles"],
    ]);
    expect(groups[0]?.every((action) => action.disabled)).toBe(true);
    expect(groups[2]?.[0]?.checked).toBe(true);
  });
});
