import type { FileTree, FileTreeRenameEvent, FileTreeRenamingConfig } from "@pierre/trees";
import {
  FileChangeHistory,
  joinEntryPath,
  parentEntryPath,
  topmostEntryPaths,
  validateEntryName,
} from "@t3tools/client-runtime/file-explorer";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  PROJECT_ENTRY_IMPORT_MAX_BYTES,
  type ProjectChangeEntryResult,
  type ProjectEntryChange,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { readLocalApi } from "~/localApi";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { flushFileSavesUnder } from "./fileSaveSessions";

/** A row Pierre renames in place while the user types a new entry's name. */
const PLACEHOLDER_NAME = ".t3-new-entry";

interface PendingCreate {
  readonly kind: "file" | "directory";
  readonly directory: string;
  readonly treePath: string;
}

export interface DroppedFile {
  readonly relativePath: string;
  readonly file: File;
}

const treePathOf = (path: string, isFolder: boolean) => (isFolder ? `${path}/` : path);
const leafName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function failureOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "failure" in error
    ? String(error.failure)
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The change could not be made.";
}

async function encodeBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Creates, renames, deletes, duplicates, moves and imports tree entries, with undo. */
export function useFileTreeEditing(options: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly canWrite: boolean;
  readonly isMac: boolean;
  readonly model: () => FileTree | null;
  readonly entryKind: (relativePath: string) => "file" | "directory" | undefined;
  readonly loadDirectory: (relativePath: string) => void;
  readonly refresh: () => void;
  /** Rebuilds the tree from the last listing after a change Pierre already showed failed. */
  readonly resync: () => void;
  readonly selectedPath: string | null;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const changeEntry = useAtomCommand(projectEnvironment.changeEntry, { reportFailure: false });
  const [history] = useState(() => new FileChangeHistory());
  const [error, setError] = useState<string | null>(null);
  const pendingCreate = useRef<PendingCreate | null>(null);
  const typedName = useRef("");

  const run = async (change: ProjectEntryChange): Promise<ProjectChangeEntryResult> => {
    const result = await changeEntry({
      environmentId: options.environmentId,
      input: { cwd: options.cwd, change },
    });
    if (result._tag === "Success") return result.value;
    throw squashAtomCommandFailure(result);
  };

  /** Applies changes in order and records them as one undo step, even when a later one fails. */
  const apply = async (changes: readonly ProjectEntryChange[]) => {
    const applied: { change: ProjectEntryChange; result: ProjectChangeEntryResult }[] = [];
    let failure: { readonly cause: unknown } | null = null;
    for (const change of changes) {
      try {
        applied.push({ change, result: await run(change) });
      } catch (cause) {
        failure = { cause };
        break;
      }
    }
    history.record(applied);
    if (applied.length > 0) options.refresh();
    if (failure) throw failure.cause;
    const failures = applied.flatMap(({ result }) => result.failures);
    setError(
      failures.length === 0
        ? null
        : `${failures.length === 1 ? failures[0]!.relativePath : `${failures.length} items`}: ${failures[0]!.message}`,
    );
    return applied.map(({ result }) => result);
  };

  const flush = (relativePath: string) =>
    flushFileSavesUnder({ environmentId: options.environmentId, cwd: options.cwd }, relativePath);

  /** Focuses Pierre's rename input, replacing its text when a value is given. */
  const fillRenameInput = (value: string | undefined, attempt = 0) => {
    const input = options
      .model()
      ?.getFileTreeContainer()
      ?.shadowRoot?.querySelector<HTMLInputElement>("[data-item-rename-input]");
    if (!input) {
      // Pierre renders the input on its next frame.
      if (attempt < 5) requestAnimationFrame(() => fillRenameInput(value, attempt + 1));
      return;
    }
    if (value !== undefined) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.focus();
  };

  const startRename = (relativePath: string, value?: string) => {
    if (!options.canWrite) return;
    const kind = options.entryKind(relativePath);
    const model = options.model();
    if (!model || kind === undefined) return;
    if (!model.startRenaming(treePathOf(relativePath, kind === "directory"))) return;
    // A closing context menu hands focus back to the row; take it for the input.
    fillRenameInput(value);
  };

  const startCreate = (kind: "file" | "directory", directory: string, value = "") => {
    const model = options.model();
    if (!options.canWrite || !model) return;
    const previous = pendingCreate.current;
    if (previous && model.getItem(previous.treePath))
      model.remove(previous.treePath, { recursive: true });
    if (directory !== "") {
      options.loadDirectory(directory);
      const folder = model.getItem(`${directory}/`);
      if (folder && "expand" in folder) folder.expand();
    }
    const treePath = treePathOf(joinEntryPath(directory, PLACEHOLDER_NAME), kind === "directory");
    if (!model.getItem(treePath)) model.add(treePath);
    pendingCreate.current = { kind, directory, treePath };
    model.startRenaming(treePath, { removeIfCanceled: true });
    fillRenameInput(value);
  };

  const commitCreate = async (create: PendingCreate, name: string) => {
    const model = options.model();
    const relativePath = joinEntryPath(create.directory, name);
    const invalid = validateEntryName(name, {
      allowNested: true,
      taken: () => options.entryKind(relativePath) !== undefined,
    });
    const dropRow = () => {
      if (model?.getItem(create.treePath)) model.remove(create.treePath, { recursive: true });
      // Pierre may have moved the placeholder to the typed name; a real entry there stays.
      const moved = treePathOf(relativePath, create.kind === "directory");
      if (model?.getItem(moved) && options.entryKind(relativePath) === undefined) {
        model.remove(moved, { recursive: true });
      }
    };
    if (invalid !== null) {
      queueMicrotask(() => {
        dropRow();
        setError(invalid);
        startCreate(create.kind, create.directory, name);
      });
      return;
    }
    try {
      await apply([{ _tag: "create", relativePath, kind: create.kind }]);
      pendingCreate.current = null;
      if (model?.getItem(create.treePath)) model.remove(create.treePath, { recursive: true });
      if (create.kind === "file") options.onOpenFile(relativePath);
    } catch (cause) {
      dropRow();
      setError(messageOf(cause));
      startCreate(create.kind, create.directory, name);
    }
  };

  const commitRename = async (event: FileTreeRenameEvent) => {
    const { sourcePath, destinationPath, isFolder } = event;
    const name = leafName(destinationPath);
    const revert = () => {
      const model = options.model();
      const destination = treePathOf(destinationPath, isFolder);
      if (model?.getItem(destination)) model.move(destination, treePathOf(sourcePath, isFolder));
    };
    const invalid = validateEntryName(name, { allowNested: false });
    if (invalid !== null) {
      // Pierre moves the row right after this callback returns.
      queueMicrotask(() => {
        revert();
        setError(invalid);
        startRename(sourcePath, name);
      });
      return;
    }
    try {
      await flush(sourcePath);
      await apply([{ _tag: "move", relativePath: sourcePath, newRelativePath: destinationPath }]);
      const selected = options.selectedPath;
      if (selected === sourcePath || selected?.startsWith(`${sourcePath}/`)) {
        options.onOpenFile(`${destinationPath}${selected.slice(sourcePath.length)}`);
      }
    } catch (cause) {
      revert();
      setError(messageOf(cause));
      startRename(sourcePath, name);
    }
  };

  // Pierre reads these once when the tree is built, so they must always see the latest render.
  const canRename = useStableCallback(() => options.canWrite);
  const onRename = useStableCallback((event: FileTreeRenameEvent) => {
    const create = pendingCreate.current;
    if (create && treePathOf(event.sourcePath, event.isFolder) === create.treePath) {
      void commitCreate(create, leafName(event.destinationPath));
      return;
    }
    void commitRename(event);
  });
  const onRenameError = useStableCallback((message: string) => {
    const create = pendingCreate.current;
    const model = options.model();
    // Pierre refuses "/" in a name; a new entry takes a nested path such as `src/a.ts`.
    if (create && model?.getItem(create.treePath)) {
      void commitCreate(create, typedName.current.trim());
      return;
    }
    setError(message);
    const focused = model?.getFocusedPath()?.replace(/\/$/, "");
    if (focused) startRename(focused, typedName.current);
  });
  const renaming: FileTreeRenamingConfig = { canRename, onRename, onError: onRenameError };

  const requestDelete = async (paths: readonly string[]) => {
    const targets = topmostEntryPaths(paths);
    if (!options.canWrite || targets.length === 0) return;
    const api = readLocalApi();
    if (!api) return;
    const subject = targets.length === 1 ? `"${leafName(targets[0]!)}"` : `${targets.length} items`;
    const undoKey = options.isMac ? "⌘Z" : "Ctrl+Z";
    const confirmed = await api.dialogs.confirm(
      `Move ${subject} to the Trash?\nYou can put ${targets.length === 1 ? "it" : "them"} back with ${undoKey}.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    await Promise.all(targets.map(flush));
    try {
      await apply([{ _tag: "delete", relativePaths: targets, mode: "trash" }]);
    } catch (cause) {
      if (failureOf(cause) !== "trash_unavailable") {
        setError(messageOf(cause));
        return;
      }
      const permanent = await api.dialogs.confirm(
        `Delete ${subject} permanently?\n${messageOf(cause)} This cannot be undone.`,
        { variant: "destructive" },
      );
      if (!permanent) return;
      try {
        await apply([{ _tag: "delete", relativePaths: targets, mode: "permanent" }]);
      } catch (permanentCause) {
        setError(messageOf(permanentCause));
      }
    }
  };

  const guarded = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const duplicate = (relativePath: string) =>
    guarded(async () => {
      await flush(relativePath);
      await apply([{ _tag: "duplicate", relativePath }]);
    });

  /** Moves dropped rows into a folder; Pierre has already shown the move. */
  const moveInto = async (paths: readonly string[], directory: string) => {
    const moves = topmostEntryPaths(paths).flatMap((path): ProjectEntryChange[] =>
      parentEntryPath(path) === directory || directory === path || directory.startsWith(`${path}/`)
        ? []
        : [
            {
              _tag: "move",
              relativePath: path,
              newRelativePath: joinEntryPath(directory, leafName(path)),
            },
          ],
    );
    if (!options.canWrite || moves.length === 0) return;
    try {
      for (const move of moves) if (move._tag === "move") await flush(move.relativePath);
      await apply(moves);
    } catch (cause) {
      setError(messageOf(cause));
      options.resync();
    }
  };

  const importFiles = async (files: readonly DroppedFile[], directory: string) => {
    if (!options.canWrite || files.length === 0) return;
    const tooLarge = files.filter(({ file }) => file.size > PROJECT_ENTRY_IMPORT_MAX_BYTES);
    await guarded(async () => {
      const changes: ProjectEntryChange[] = [];
      for (const { relativePath, file } of files) {
        if (file.size > PROJECT_ENTRY_IMPORT_MAX_BYTES) continue;
        changes.push({
          _tag: "import",
          relativePath: joinEntryPath(directory, relativePath),
          contentsBase64: await encodeBase64(file),
        });
      }
      if (changes.length > 0) await apply(changes);
    });
    if (tooLarge.length > 0) {
      setError(
        `${tooLarge.length === 1 ? `"${tooLarge[0]!.relativePath}" is` : `${tooLarge.length} files are`} larger than 25 MB and ${tooLarge.length === 1 ? "was" : "were"} not added.`,
      );
    }
  };

  const step = (direction: "undo" | "redo") =>
    guarded(async () => {
      // A step can trash or move any file, so pending edits land before it does.
      await flush("");
      const moved = await (direction === "undo" ? history.undo(run) : history.redo(run));
      if (moved) {
        setError(null);
        options.refresh();
      }
    });

  return {
    renaming,
    error,
    dismissError: () => setError(null),
    /** Tracks what the user types into Pierre's rename input, which lives in its shadow root. */
    captureTypedName: useStableCallback((event: { nativeEvent: Event }) => {
      const target = event.nativeEvent.composedPath()[0];
      if (target instanceof HTMLInputElement && target.hasAttribute("data-item-rename-input")) {
        typedName.current = target.value;
      }
    }),
    startCreate,
    startRename,
    requestDelete,
    duplicate,
    moveInto,
    importFiles,
    undo: () => step("undo"),
    redo: () => step("redo"),
  };
}
