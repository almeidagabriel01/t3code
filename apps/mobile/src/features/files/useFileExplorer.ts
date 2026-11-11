import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import {
  type FileExplorerActionId,
  type FileExplorerCapabilities,
  fileExplorerRowActions,
  joinEntryPath,
  newEntryDirectory,
  parentEntryPath,
  validateEntryName,
} from "@t3tools/client-runtime/file-explorer";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectChangeEntryResult,
  ProjectEntry,
  ProjectEntryChange,
} from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { AsyncResult } from "effect/reactivity";

import type { AppBarMenu } from "../../components/ui/AppBar.types";
import * as Dialog from "../../components/ui/Dialog";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { basename, resolveWorkspaceFilePath } from "./filePath";

type EntryKind = ProjectEntry["kind"];

// Phones have no terminal pane, browser panel, editors, Finder or downloads beside the tree.
const MOBILE_CAPABILITIES: Omit<FileExplorerCapabilities, "canWrite"> = {
  copyFile: false,
  addAsProject: false,
  openInTerminal: false,
  openInBrowser: false,
  // The file screen already opens Markdown rendered.
  markdownPreview: false,
  download: false,
  downloadFolder: false,
  findInFolder: true,
  openIn: false,
  revealLabel: undefined,
  isMac: false,
};

const ICONS: Partial<Record<FileExplorerActionId, string>> = {
  "new-file": "doc.badge.plus",
  "new-folder": "folder.badge.plus",
  "copy-path": "doc.on.doc",
  "copy-relative-path": "link",
  duplicate: "plus.square.on.square",
  "view-file": "doc.text",
  "collapse-folder": "chevron.up",
  "find-in-folder": "text.magnifyingglass",
  rename: "pencil",
  delete: "trash",
};

/** The long-press menu for one row, in the shared explorer order, without desktop shortcuts. */
export function fileExplorerMenuActions(input: {
  readonly kind: EntryKind;
  readonly path: string;
  readonly isExpanded: boolean;
  readonly canWrite: boolean;
}): MenuAction[] {
  return fileExplorerRowActions({
    ...input,
    selectionSize: 1,
    capabilities: { ...MOBILE_CAPABILITIES, canWrite: input.canWrite },
  })
    .flat()
    .map((action) => ({
      id: action.id,
      title: action.label,
      ...(ICONS[action.id] ? { image: ICONS[action.id] } : {}),
      ...(action.disabled || action.destructive
        ? {
            attributes: {
              ...(action.disabled ? { disabled: true } : {}),
              ...(action.destructive ? { destructive: true } : {}),
            },
          }
        : {}),
    }));
}

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "The change could not be made.";
const failureOf = (error: unknown) =>
  typeof error === "object" && error !== null && "failure" in error ? error.failure : undefined;

export function useFileExplorer(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly selectedPath: string | null;
  readonly setExpandedPaths: (
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
  readonly onOpenFile: (path: string) => void;
  readonly onFindInFolder: (path: string) => void;
  readonly refresh: () => void;
}) {
  const { environmentId, cwd } = input;
  const canWrite =
    useAtomValue(projectEnvironment.changeEntry.permissionAtom(environmentId)) &&
    environmentId !== null &&
    cwd !== null;
  const changeEntry = useAtomCommand(projectEnvironment.changeEntry, { reportFailure: false });
  const kinds = new Map(input.entries.map((entry) => [entry.path, entry.kind]));

  const run = async (change: ProjectEntryChange): Promise<ProjectChangeEntryResult> => {
    if (environmentId === null || cwd === null) throw new Error("Reconnect and try again.");
    const result = await changeEntry({ environmentId, input: { cwd, change } });
    if (!AsyncResult.isSuccess(result)) {
      throw AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : result;
    }
    input.refresh();
    const [first, ...rest] = result.value.failures;
    if (first) {
      Dialog.alert(
        rest.length === 0 ? `Couldn't change ${first.relativePath}` : "Some items were not changed",
        first.message,
      );
    }
    return result.value;
  };

  const attempt = (work: () => Promise<unknown>) =>
    void work().catch((error: unknown) =>
      Dialog.alert("Couldn't change the file", messageOf(error)),
    );

  const expand = (path: string) => input.setExpandedPaths((current) => new Set(current).add(path));

  /** Asks for a name and asks again, with the problem as the message, until it is usable. */
  const promptName = (request: {
    readonly title: string;
    readonly message: string;
    readonly confirmText: string;
    readonly initialValue: string;
    readonly allowNested: boolean;
    readonly taken: (name: string) => boolean;
    readonly onValid: (name: string) => void;
  }) =>
    Dialog.prompt({
      title: request.title,
      message: request.message,
      placeholder: request.allowNested ? "name or folder/name" : "name",
      initialValue: request.initialValue,
      confirmText: request.confirmText,
      onConfirm: (value) => {
        const problem = validateEntryName(value, request);
        if (problem === null) request.onValid(value.trim().replace(/\/+$/, ""));
        else promptName({ ...request, message: problem, initialValue: value });
      },
    });

  const create = (kind: EntryKind, directory: string) =>
    promptName({
      title: kind === "file" ? "New File" : "New Folder",
      message: directory === "" ? "In the project. Use / to add folders." : `In ${directory}/`,
      confirmText: "Create",
      initialValue: "",
      allowNested: true,
      taken: (name) => kinds.has(joinEntryPath(directory, name)),
      onValid: (name) =>
        attempt(async () => {
          const relativePath = joinEntryPath(directory, name);
          await run({ _tag: "create", relativePath, kind });
          if (directory !== "") expand(directory);
          if (kind === "file") input.onOpenFile(relativePath);
          else expand(relativePath);
        }),
    });

  const rename = (path: string) => {
    const name = basename(path);
    const parent = parentEntryPath(path);
    promptName({
      title: "Rename",
      message: parent === "" ? "In the project" : `In ${parent}/`,
      confirmText: "Rename",
      initialValue: name,
      allowNested: false,
      taken: (next) => next !== name && kinds.has(joinEntryPath(parent, next)),
      onValid: (next) => {
        if (next === name) return;
        attempt(() =>
          run({ _tag: "move", relativePath: path, newRelativePath: joinEntryPath(parent, next) }),
        );
      },
    });
  };

  const remove = (path: string) => {
    const subject = `“${basename(path)}”`;
    Dialog.confirm({
      title: `Move ${subject} to the Trash?`,
      message: "It goes to the Trash on the machine that runs T3 Code.",
      confirmText: "Move to Trash",
      destructive: true,
      onConfirm: () =>
        void run({ _tag: "delete", relativePaths: [path], mode: "trash" }).catch(
          (error: unknown) => {
            if (failureOf(error) !== "trash_unavailable") {
              Dialog.alert("Couldn't delete the file", messageOf(error));
              return;
            }
            Dialog.confirm({
              title: `Delete ${subject} permanently?`,
              message: `${messageOf(error)} This cannot be undone.`,
              confirmText: "Delete",
              destructive: true,
              onConfirm: () =>
                attempt(() => run({ _tag: "delete", relativePaths: [path], mode: "permanent" })),
            });
          },
        ),
    });
  };

  const runAction = (id: string, path: string, kind: EntryKind) => {
    switch (id as FileExplorerActionId) {
      case "new-file":
      case "new-folder":
        create(id === "new-file" ? "file" : "directory", newEntryDirectory({ kind, path }));
        return;
      case "copy-path":
        if (cwd !== null) void Clipboard.setStringAsync(resolveWorkspaceFilePath(cwd, path));
        return;
      case "copy-relative-path":
        void Clipboard.setStringAsync(path);
        return;
      case "duplicate":
        attempt(() => run({ _tag: "duplicate", relativePath: path }));
        return;
      case "view-file":
        input.onOpenFile(path);
        return;
      case "collapse-folder":
        input.setExpandedPaths(
          (current) =>
            new Set([...current].filter((open) => open !== path && !open.startsWith(`${path}/`))),
        );
        return;
      case "find-in-folder":
        input.onFindInFolder(path);
        return;
      case "rename":
        rename(path);
        return;
      case "delete":
        remove(path);
        return;
    }
  };

  const headerDirectory = input.selectedPath === null ? "" : parentEntryPath(input.selectedPath);
  const headerMenu: AppBarMenu = {
    title: "New",
    icon: "plus",
    items: [
      {
        id: "new-file",
        title: "New File",
        icon: "doc.badge.plus",
        disabled: !canWrite,
        onPress: () => create("file", headerDirectory),
      },
      {
        id: "new-folder",
        title: "New Folder",
        icon: "folder.badge.plus",
        disabled: !canWrite,
        onPress: () => create("directory", headerDirectory),
      },
    ],
  };

  return {
    headerMenu,
    rowMenu: (path: string, kind: EntryKind, isExpanded: boolean) => ({
      actions: fileExplorerMenuActions({ kind, path, isExpanded, canWrite }),
      onPressAction: (id: string) => runAction(id, path, kind),
    }),
  };
}
