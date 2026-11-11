import type { ProjectChangeEntryResult, ProjectEntryChange } from "@t3tools/contracts";

/** Returns why a typed name is unusable, or null. Nested `a/b.ts` paths are allowed when creating. */
export function validateEntryName(
  value: string,
  options: { readonly allowNested: boolean; readonly taken?: (name: string) => boolean },
): string | null {
  const name = value.trim().replace(/\/+$/, "");
  if (name.length === 0) return "Enter a name.";
  if (/[\u0000-\u001f]/.test(name)) return "Names cannot contain control characters.";
  if (name.startsWith("/") || name.startsWith("~")) return "Use a name inside the project.";
  if (!options.allowNested && name.includes("/")) return 'Names cannot contain "/".';
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return 'Names cannot be empty, "." or "..".';
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    return "Git metadata cannot be changed here.";
  }
  if (options.taken?.(name)) return `"${name}" already exists.`;
  return null;
}

export function joinEntryPath(directory: string, name: string): string {
  const clean = name.trim().replace(/\/+$/, "");
  return directory === "" ? clean : `${directory.replace(/\/+$/, "")}/${clean}`;
}

export function parentEntryPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "" : relativePath.slice(0, slash);
}

/** The change that puts back what `change` did, or null when it cannot be undone. */
export function inverseEntryChange(
  change: ProjectEntryChange,
  result: ProjectChangeEntryResult,
): ProjectEntryChange | null {
  const paths = result.entries.map((entry) => entry.relativePath);
  switch (change._tag) {
    case "create":
    case "import":
    case "duplicate":
    case "restore":
      // Undoing an addition sends it to the trash, never deletes it outright.
      return paths.length === 0 ? null : { _tag: "delete", relativePaths: paths, mode: "trash" };
    case "move": {
      const destination = paths[0];
      return destination === undefined || destination === change.relativePath
        ? null
        : { _tag: "move", relativePath: destination, newRelativePath: change.relativePath };
    }
    case "delete": {
      const tokens = result.entries.flatMap((entry) =>
        entry.restoreToken === undefined ? [] : [entry.restoreToken],
      );
      // A permanent delete, or one that skipped the trash for any item, has nothing to put back.
      return tokens.length === 0 || tokens.length !== result.entries.length
        ? null
        : { _tag: "restore", restoreTokens: tokens };
    }
  }
}

type RunEntryChange = (change: ProjectEntryChange) => Promise<ProjectChangeEntryResult>;

const MAX_HISTORY = 100;

/** Undo and redo for file explorer edits. Each step is the list of changes one action made. */
export class FileChangeHistory {
  #undo: ProjectEntryChange[][] = [];
  #redo: ProjectEntryChange[][] = [];

  get canUndo() {
    return this.#undo.length > 0;
  }

  get canRedo() {
    return this.#redo.length > 0;
  }

  /** Records a new action; it clears redo, as any editor does. */
  record(applied: ReadonlyArray<{ change: ProjectEntryChange; result: ProjectChangeEntryResult }>) {
    const inverses = applied
      .map(({ change, result }) => inverseEntryChange(change, result))
      .filter((change) => change !== null)
      .reverse();
    if (inverses.length === 0) return;
    this.#undo = [...this.#undo, inverses].slice(-MAX_HISTORY);
    this.#redo = [];
  }

  undo(run: RunEntryChange) {
    return this.#step(run, "undo");
  }

  redo(run: RunEntryChange) {
    return this.#step(run, "redo");
  }

  /** A failed step is dropped: the files no longer match what it would put back. */
  async #step(run: RunEntryChange, direction: "undo" | "redo"): Promise<boolean> {
    const from = direction === "undo" ? this.#undo : this.#redo;
    const step = from.at(-1);
    if (step === undefined) return false;
    from.pop();
    const inverses: ProjectEntryChange[] = [];
    for (const change of step) {
      const inverse = inverseEntryChange(change, await run(change));
      if (inverse !== null) inverses.unshift(inverse);
    }
    if (inverses.length > 0) (direction === "undo" ? this.#redo : this.#undo).push(inverses);
    return true;
  }
}

export type FileExplorerActionId =
  | "new-file"
  | "new-folder"
  | "copy-file"
  | "copy-path"
  | "copy-relative-path"
  | "duplicate"
  | "add-as-project"
  | "open-in-terminal"
  | "view-file"
  | "open-in-browser"
  | "open-markdown-preview"
  | "download"
  | "collapse-folder"
  | "find-in-folder"
  | "open-in"
  | "reveal"
  | "rename"
  | "delete"
  | "collapse-all"
  | "refresh"
  | "toggle-dotfiles";

export interface FileExplorerAction {
  readonly id: FileExplorerActionId;
  readonly label: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly checked?: boolean;
  readonly shortcut?: string;
}

/** What the surface showing the menu can do; anything false is left out of the menu. */
export interface FileExplorerCapabilities {
  readonly canWrite: boolean;
  readonly copyFile: boolean;
  readonly addAsProject: boolean;
  readonly openInTerminal: boolean;
  readonly openInBrowser: boolean;
  readonly markdownPreview: boolean;
  readonly download: boolean;
  readonly downloadFolder: boolean;
  readonly findInFolder: boolean;
  readonly openIn: boolean;
  /** "Reveal in Finder" and the like; undefined when the host cannot reveal files. */
  readonly revealLabel: string | undefined;
  readonly isMac: boolean;
}

const MARKDOWN_PATH = /\.(md|mdx|markdown)$/i;

/** The row menu, in groups, following Orca's file explorer order. */
export function fileExplorerRowActions(input: {
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly isExpanded: boolean;
  readonly selectionSize: number;
  readonly capabilities: FileExplorerCapabilities;
}): FileExplorerAction[][] {
  const { capabilities: can, kind } = input;
  const locked = !can.canWrite;
  const deleteAction: FileExplorerAction = {
    id: "delete",
    label: "Delete",
    destructive: true,
    disabled: locked,
    shortcut: can.isMac ? "⌘⌫" : "Del",
  };
  if (input.selectionSize > 1) {
    return [
      [
        { id: "copy-path", label: "Copy Paths" },
        { id: "copy-relative-path", label: "Copy Relative Paths" },
      ],
      [deleteAction],
    ];
  }
  const isFile = kind === "file";
  const groups: (FileExplorerAction | false)[][] = [
    [
      { id: "new-file", label: "New File", disabled: locked },
      { id: "new-folder", label: "New Folder", disabled: locked },
    ],
    [
      can.copyFile && isFile && { id: "copy-file", label: "Copy" },
      { id: "copy-path", label: "Copy Path" },
      { id: "copy-relative-path", label: "Copy Relative Path" },
      { id: "duplicate", label: "Duplicate", disabled: locked },
    ],
    [
      !isFile && can.addAsProject && { id: "add-as-project", label: "Add as Project…" },
      !isFile && can.openInTerminal && { id: "open-in-terminal", label: "Open in Terminal" },
      isFile && { id: "view-file", label: "View File" },
      isFile && can.openInBrowser && { id: "open-in-browser", label: "Open in Browser" },
      isFile &&
        can.markdownPreview &&
        MARKDOWN_PATH.test(input.path) && {
          id: "open-markdown-preview",
          label: "Open Markdown Preview",
        },
      (isFile ? can.download : can.downloadFolder) && {
        id: "download",
        label: isFile ? "Download" : "Download Folder",
      },
    ],
    [
      !isFile && input.isExpanded && { id: "collapse-folder", label: "Collapse Folder" },
      !isFile && can.findInFolder && { id: "find-in-folder", label: "Find in Folder" },
    ],
    [
      can.openIn && { id: "open-in", label: "Open in" },
      can.revealLabel !== undefined && { id: "reveal", label: can.revealLabel },
    ],
    [
      {
        id: "rename",
        label: "Rename",
        disabled: locked,
        shortcut: can.isMac ? "↩" : "F2",
      },
      deleteAction,
    ],
  ];
  return groups
    .map((group) => group.filter((action) => action !== false))
    .filter((group) => group.length > 0);
}

/** The menu for empty space in the tree. */
export function fileExplorerBackgroundActions(input: {
  readonly canWrite: boolean;
  readonly showDotfiles: boolean;
}): FileExplorerAction[][] {
  return [
    [
      { id: "new-file", label: "New File", disabled: !input.canWrite },
      { id: "new-folder", label: "New Folder", disabled: !input.canWrite },
    ],
    [
      { id: "collapse-all", label: "Collapse All" },
      { id: "refresh", label: "Refresh Explorer" },
    ],
    [{ id: "toggle-dotfiles", label: "Show Dotfiles", checked: input.showDotfiles }],
  ];
}

/** Folder a new entry goes in: inside a folder, beside a file. */
export function newEntryDirectory(target: {
  readonly kind: "file" | "directory";
  readonly path: string;
}): string {
  return target.kind === "directory" ? target.path : parentEntryPath(target.path);
}

/** Keeps the topmost selected entries: a child selected with its folder goes with the folder. */
export function topmostEntryPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((path) => !unique.some((other) => path.startsWith(`${other}/`)));
}

export function isDotfilePath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}
