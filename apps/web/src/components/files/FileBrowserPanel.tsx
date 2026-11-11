import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
  FileTree as FileTreeModel,
  FileTreeDropResult,
} from "@pierre/trees";
import type { ContextMenuItem, EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import {
  type FileExplorerActionId,
  type FileExplorerCapabilities,
  fileExplorerBackgroundActions,
  fileExplorerRowActions,
  isDotfilePath,
  newEntryDirectory,
} from "@t3tools/client-runtime/file-explorer";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FilePlusIcon,
  FolderPlusIcon,
  XIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { isLoopbackHostname } from "~/environments/primary/target";
import { isMacPlatform } from "~/lib/utils";
import { readPreparedConnection } from "~/state/session";
import { projectEnvironment } from "~/state/projects";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { joinHostPath } from "./filePath";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
import { loadFileAncestors } from "./loadFileAncestors";
import { useDirectoryEntries } from "./useDirectoryEntries";
import { toFileExplorerMenuItems } from "./fileExplorerMenu";
import {
  collectDroppedFiles,
  dropTargetDirectory,
  isExternalFileDrag,
  isOverTreeRow,
} from "./fileTreeImport";
import { useFileTreeEditing } from "./useFileTreeEditing";
import type { FileExplorerHostActions } from "./useFileExplorerHostActions";
import { isBrowserPreviewFile } from "~/browser/openFileInPreview";
import { useAtomValue } from "@effect/atom-react";
import { useProjectPathSearch } from "~/state/queries";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  /** Host-folder entries use absolute paths. Avoid full traversal: disable expand-all and search only
   * loaded folders. */
  hostFolder?: boolean;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
  /** Actions that need the thread or the panel, such as terminals and the browser. */
  hostActions?: FileExplorerHostActions;
}

const SHOW_DOTFILES_STORAGE_KEY = "t3code.fileExplorerShowDotfiles";
const stripSlash = (path: string) => path.replace(/\/$/, "");

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function HeaderIconButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField({
  inputRef,
  ...props
}: {
  inputRef?: React.Ref<HTMLInputElement>;
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        ref={inputRef}
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        data-workspace-focus-default
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

function buildTreeEntries(
  directoryEntries: readonly ProjectEntry[],
  searchEntries: readonly ProjectEntry[],
  searchPending: boolean,
  query: string,
  include: (path: string) => boolean,
) {
  const result = new Map(
    directoryEntries.filter((entry) => include(entry.path)).map((entry) => [entry.path, entry]),
  );
  if (query.trim() && !searchPending) {
    for (const entry of searchEntries) {
      if (!include(entry.path)) continue;
      if (!result.has(entry.path)) result.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join("/");
        if (!result.has(path)) result.set(path, { path, kind: "directory" });
      }
    }
  }
  const entries = [...result.values()];
  const entryKinds: ReadonlyMap<string, ProjectEntry["kind"]> = new Map(
    entries.map((entry) => [entry.path, entry.kind] as const),
  );
  const treePaths = entries.map(treePath);
  const directories = entries.filter((entry) => entry.kind === "directory");
  const directoryPaths = directories.map(treePath);
  // Expanding a folder lists it, and an ignored one such as `node_modules` can hold tens of
  // thousands, so expand all skips ignored folders. They still open by hand.
  const expandableDirectoryPaths = directories.filter((entry) => !entry.ignored).map(treePath);
  return { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths };
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  hostFolder = false,
  hostActions = {},
}: FileBrowserPanelProps) {
  const panelPath = (relativePath: string) =>
    hostFolder ? joinHostPath(cwd, relativePath) : relativePath;
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const {
    entries: directoryEntries,
    load,
    refresh,
    ready,
    error,
    isPending,
    loadingDirectories,
  } = useDirectoryEntries(environmentId, cwd);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const isMac = isMacPlatform(navigator.platform);
  const canWrite =
    useAtomValue(projectEnvironment.changeEntry.permissionAtom(environmentId)) && !hostFolder;
  const [showDotfiles, setShowDotfiles] = useLocalStorage(
    SHOW_DOTFILES_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [searchScope, setSearchScope] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd: hostFolder ? null : cwd, query: query.slice(0, 256) },
    200,
  );
  const { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths } =
    buildTreeEntries(
      directoryEntries,
      pathSearch.entries,
      pathSearch.isPending,
      query,
      (path) =>
        (showDotfiles || !isDotfilePath(path)) &&
        (searchScope === null ||
          path === searchScope ||
          path.startsWith(`${searchScope}/`) ||
          searchScope.startsWith(`${path}/`)),
    );
  const entryKindsRef = useRef(entryKinds);
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // Shadow-DOM row rects are unreliable; capture the composed contextmenu event's viewport position.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const modelRef = useRef<FileTreeModel | null>(null);
  const previousTreePathsForResync = useRef<readonly string[]>([]);

  const absolutePath = (relativePath: string) => joinHostPath(cwd, relativePath);
  const httpBaseUrl = readPreparedConnection(environmentId)?.httpBaseUrl;
  // A server on another machine than this client: its files can only reach here as downloads.
  const remote = (() => {
    try {
      return httpBaseUrl ? !isLoopbackHostname(new URL(httpBaseUrl).hostname) : false;
    } catch {
      return false;
    }
  })();
  const capabilities: FileExplorerCapabilities = {
    canWrite,
    copyFile: isMac && !remote && typeof window.desktopBridge?.copyFilesToClipboard === "function",
    addAsProject: hostActions.addAsProject !== undefined,
    openInTerminal: hostActions.openInTerminal !== undefined,
    openInBrowser: hostActions.openInBrowser !== undefined,
    markdownPreview: hostActions.openMarkdownPreview !== undefined,
    download: remote && hostActions.download !== undefined,
    downloadFolder: remote && hostActions.download !== undefined && !hostFolder,
    findInFolder: !hostFolder,
    openIn: fileContextMenu.capabilities.editorIds.some((id) => id !== "file-manager"),
    revealLabel: fileContextMenu.capabilities.revealLabel,
    isMac,
  };

  const handleRefresh = () => {
    refresh();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };

  const editing = useFileTreeEditing({
    environmentId,
    cwd,
    canWrite,
    isMac,
    model: () => modelRef.current,
    entryKind: (relativePath) => entryKindsRef.current.get(relativePath),
    loadDirectory: (relativePath) => void load(relativePath),
    refresh: () => {
      refresh();
      if (query.trim()) pathSearch.refresh();
    },
    resync: () => modelRef.current?.resetPaths(previousTreePathsForResync.current),
    selectedPath,
    onOpenFile: (relativePath) => onOpenFile(panelPath(relativePath)),
  });

  const copyText = async (text: string, title: string, description: string) => {
    try {
      await writeTextToClipboard(text);
      toastManager.add({ type: "success", title, description });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to copy",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  const collapseFolder = useStableCallback((relativePath: string) => {
    const model = modelRef.current;
    if (!model) return;
    setExpandAll(false);
    setAllDirectoriesExpanded(
      model,
      directoryPaths.filter(
        (path) => path === `${relativePath}/` || path.startsWith(`${relativePath}/`),
      ),
      false,
    );
  });

  const findInFolder = useStableCallback((relativePath: string) => {
    setSearchScope(relativePath);
    const folder = modelRef.current?.getItem(`${relativePath}/`);
    if (folder && "expand" in folder) folder.expand();
    searchInputRef.current?.focus();
  });

  const runExplorerAction = useStableCallback(
    async (
      id: string,
      target: { readonly kind: "file" | "directory"; readonly path: string } | null,
      selection: readonly string[],
    ) => {
      if (id.startsWith("editor:") && target) {
        const fileTarget = { environmentId, filePath: target.path, workspaceRoot: cwd };
        await fileContextMenu.activate(id as FileContextMenuAction, fileTarget);
        return;
      }
      const mention = target ? serializeComposerFileLink(panelPath(target.path)) : "";
      switch (id as FileExplorerActionId | "copy-mention" | "add-to-chat") {
        case "new-file":
        case "new-folder":
          editing.startCreate(
            id === "new-file" ? "file" : "directory",
            target ? newEntryDirectory(target) : "",
          );
          return;
        case "collapse-all":
          setExpandAll(false);
          if (modelRef.current) setAllDirectoriesExpanded(modelRef.current, directoryPaths, false);
          return;
        case "refresh":
          handleRefresh();
          return;
        case "toggle-dotfiles":
          setShowDotfiles((current) => !current);
          return;
      }
      if (!target) return;
      switch (id as FileExplorerActionId | "copy-mention" | "add-to-chat") {
        case "copy-file":
          if (!(await window.desktopBridge?.copyFilesToClipboard(selection.map(absolutePath)))) {
            toastManager.add({ type: "error", title: "Could not copy the file" });
          }
          return;
        case "copy-path":
          await copyText(
            selection.map(absolutePath).join("\n"),
            selection.length > 1 ? "Paths copied" : "Path copied",
            selection.length > 1 ? `${selection.length} paths` : absolutePath(target.path),
          );
          return;
        case "copy-relative-path":
          await copyText(
            selection.join("\n"),
            selection.length > 1 ? "Relative paths copied" : "Relative path copied",
            selection.length > 1 ? `${selection.length} paths` : target.path,
          );
          return;
        case "duplicate":
          await editing.duplicate(target.path);
          return;
        case "add-as-project":
          hostActions.addAsProject?.(absolutePath(target.path));
          return;
        case "open-in-terminal":
          hostActions.openInTerminal?.(absolutePath(target.path));
          return;
        case "view-file":
          onOpenFile(panelPath(target.path));
          return;
        case "open-in-browser":
          hostActions.openInBrowser?.(target.path);
          return;
        case "open-markdown-preview":
          hostActions.openMarkdownPreview?.(target.path);
          return;
        case "download":
          hostActions.download?.(target.path, target.kind);
          return;
        case "collapse-folder":
          collapseFolder(target.path);
          return;
        case "find-in-folder":
          findInFolder(target.path);
          return;
        case "reveal":
          await fileContextMenu.activate("reveal-in-folder", {
            environmentId,
            filePath: target.path,
            workspaceRoot: cwd,
          });
          return;
        case "rename":
          editing.startRename(target.path);
          return;
        case "delete":
          await editing.requestDelete(selection);
          return;
        case "copy-mention":
          await copyText(mention, "Mention copied", target.path);
          return;
        case "add-to-chat": {
          const composer = composerRef?.current;
          if (!composer) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "Open a chat for this project and try again.",
            });
            return;
          }
          if (!composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true })) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "The chat isn't ready to accept input right now.",
            });
          }
          return;
        }
      }
    },
  );

  const openMenu = (
    items: ContextMenuItem[],
    position: { x: number; y: number },
    run: (id: string) => Promise<void>,
  ) => {
    const api = readLocalApi();
    if (!api || items.length === 0) return;
    void settlePromise(async () => {
      const clicked = await api.contextMenu.show(items, position);
      if (clicked !== null) await run(clicked);
    }).then((result) => {
      if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
    });
  };

  const openInChildren = (): ContextMenuItem[] =>
    fileContextMenu.capabilities.editorIds
      .filter((editorId) => editorId !== "file-manager")
      .flatMap(
        (editorId) =>
          fileContextMenu
            .buildItems({ environmentId, filePath: ".", workspaceRoot: cwd })
            .find((item) => item.id === "open-with")
            ?.children?.filter((child) => child.id === `editor:${editorId}`) ?? [],
      );

  const showEntryContextMenu = useStableCallback(
    (item: TreeContextMenuItem, context: TreeContextMenuOpenContext) => {
      const relativePath = stripSlash(item.path);
      const pointer = contextMenuPointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      const position = pointerIsFresh
        ? { x: pointer.x, y: pointer.y }
        : { x: anchorRect.left, y: anchorRect.bottom };
      // The app menu owns focus; the tree's outside-click handler would dismiss it before click.
      context.close({ restoreFocus: !pointerIsFresh });
      const model = modelRef.current;
      if (!model) return;
      const selected = model.getSelectedPaths().map(stripSlash);
      // Right-clicking outside the selection acts on that row alone.
      const selection =
        selected.length > 1 && selected.includes(relativePath) ? selected : [relativePath];
      const handle = model.getItem(item.path);
      const isExpanded = handle !== null && "isExpanded" in handle ? handle.isExpanded() : false;
      const target = { kind: item.kind, path: relativePath } as const;
      const groups = fileExplorerRowActions({
        kind: item.kind,
        path: relativePath,
        isExpanded,
        selectionSize: selection.length,
        capabilities: {
          ...capabilities,
          openInBrowser: capabilities.openInBrowser && isBrowserPreviewFile(relativePath),
        },
      });
      const items = toFileExplorerMenuItems(groups, {
        openInChildren: openInChildren(),
        extraGroupAfter: "duplicate",
        extraGroup:
          selection.length > 1
            ? []
            : [
                { id: "copy-mention", label: "Copy Mention", icon: "hash" },
                { id: "add-to-chat", label: "Add to Chat", icon: "message-square-plus" },
              ],
      });
      openMenu(items, position, (id) => runExplorerAction(id, target, selection));
    },
  );

  const showBackgroundContextMenu = (event: MouseEvent) => {
    if (isOverTreeRow(event.nativeEvent.composedPath())) return;
    event.preventDefault();
    openMenu(
      toFileExplorerMenuItems(fileExplorerBackgroundActions({ canWrite, showDotfiles })),
      { x: event.clientX, y: event.clientY },
      (id) => runExplorerAction(id, null, []),
    );
  };

  const handleTreeKeyDown = (event: KeyboardEvent) => {
    const origin = event.nativeEvent.composedPath()[0];
    // Typing in the rename input or search field never edits files.
    if (
      origin instanceof HTMLInputElement ||
      origin instanceof HTMLTextAreaElement ||
      (origin instanceof HTMLElement && origin.isContentEditable)
    ) {
      return;
    }
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (mod && (key === "z" || (!isMac && key === "y"))) {
      handled();
      void (key === "y" || event.shiftKey ? editing.redo() : editing.undo());
      return;
    }
    const model = modelRef.current;
    const focused = model?.getFocusedPath();
    if (!model || !focused || !canWrite) return;
    const focusedPath = stripSlash(focused);
    if (event.key === "Delete" || (event.key === "Backspace" && mod)) {
      handled();
      const selected = model.getSelectedPaths().map(stripSlash);
      void editing.requestDelete(selected.includes(focusedPath) ? selected : [focusedPath]);
      return;
    }
    // Finder renames with Return; F2 works everywhere through the tree itself.
    if (isMac && event.key === "Enter" && !mod && !event.shiftKey && !event.altKey) {
      handled();
      editing.startRename(focusedPath);
    }
  };

  const handleExternalDragOver = (event: {
    dataTransfer: DataTransfer | null;
    preventDefault: () => void;
  }) => {
    if (!canWrite || !isExternalFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
  };

  const handleExternalDrop = (event: {
    dataTransfer: DataTransfer | null;
    preventDefault: () => void;
    nativeEvent: Event;
  }) => {
    if (!canWrite || !isExternalFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    const directory = dropTargetDirectory(event.nativeEvent.composedPath());
    void collectDroppedFiles(event.dataTransfer!).then((files) =>
      editing.importFiles(files, directory),
    );
  };

  const canDropRows = useStableCallback(() => canWrite);
  const handleRowsDropped = useStableCallback((event: FileTreeDropResult) => {
    void editing.moveInto(
      event.draggedPaths.map(stripSlash),
      event.target.directoryPath === null ? "" : stripSlash(event.target.directoryPath),
    );
  });

  const loadingDirectoriesRef = useRef(loadingDirectories);
  const dragMention = createFileTreeDragMentionController(
    hostFolder ? { mentionPath: (path: string) => joinHostPath(cwd, path) } : {},
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          showEntryContextMenu(item, context);
        },
      },
    },
    dragAndDrop: { canDrop: () => canDropRows(), onDropComplete: handleRowsDropped },
    renaming: editing.renaming,
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // Update drag selection even for reveals so subsequent drags cannot use stale paths.
      dragMention.handleSelectionChange(selectedPaths);
      if (syncingSelectionRef.current) return;
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(panelPath(selectedPath));
      }
    },
    paths: [],
    renderRowDecoration: ({ item, row }) =>
      row.kind === "directory" &&
      row.isExpanded &&
      loadingDirectoriesRef.current.has(item.path.replace(/\/$/, ""))
        ? { icon: "t3-tree-icon-loading", title: "Loading…" }
        : null,
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- editing callbacks are built before the tree model exists
  useLayoutEffect(() => {
    modelRef.current = model;
  }, [model]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the Pierre tree model re-render row decorations when loading directories change
  useEffect(() => {
    if (loadingDirectoriesRef.current === loadingDirectories) return;
    loadingDirectoriesRef.current = loadingDirectories;
    model.setComposition(model.getComposition());
  }, [loadingDirectories, model]);
  const search = useFileTreeSearch(model);
  // Pierre restores the unfiltered tree when a search has no matches.
  const hasNoSearchMatches = search.value.trim().length > 0 && search.matchingPaths.length === 0;
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, expandableDirectoryPaths),
  );
  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    setAllDirectoriesExpanded(
      model,
      expanded ? expandableDirectoryPaths : directoryPaths,
      expanded,
    );
  };
  const closeSearch = () => {
    setQuery("");
    search.close();
  };
  const expandedPathsRef = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Pierre tree model to load directories as they are expanded
  useEffect(() => {
    const currentPaths = new Set(directoryPaths);
    for (const path of expandedPathsRef.current) {
      if (!currentPaths.has(path)) expandedPathsRef.current.delete(path);
    }
    const loadExpanded = () => {
      if (model.isSearchOpen()) return;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item?.isDirectory() && "isExpanded" in item && item.isExpanded()) {
          if (!expandedPathsRef.current.has(path)) {
            expandedPathsRef.current.add(path);
            void load(path.replace(/\/$/, ""));
          }
        } else {
          if (item?.isDirectory() && expandedPathsRef.current.has(path)) setExpandAll(false);
          expandedPathsRef.current.delete(path);
        }
      }
    };
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [directoryPaths, load, model]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes ignored-file status into the imperative Pierre tree model
  useEffect(() => {
    model.setGitStatus(
      entries
        .filter((entry) => entry.ignored)
        .map((entry) => ({
          path: treePath(entry),
          status: "ignored",
        })),
    );
  }, [entries, model]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected file's ancestor directories and aborts on cleanup
  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    void loadFileAncestors(selectedPath, load, { signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [load, selectedPath]);
  const handleSearchValueChange = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: () => {
      refresh();
      if (query.trim()) pathSearch.refresh();
    },
    resourceKey: `files:${environmentId}:${cwd}`,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies tree path changes to the imperative Pierre tree model as a reset or batch update
  useEffect(() => {
    if (!ready) return;
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    previousTreePathsForResync.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
      return;
    }
    // Rows the tree already shows, such as one just renamed in place, are left as they are.
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths).filter((update) =>
      update.type === "add"
        ? model.getItem(update.path) === null
        : update.type !== "remove" || model.getItem(update.path) !== null,
    );
    if (updates.length > 0) model.batch(updates);
  }, [ready, entryKinds, model, treePaths]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands every directory in the Pierre tree model while expand-all is on and no search is active
  useEffect(() => {
    if (expandAll && !query.trim())
      setAllDirectoriesExpanded(model, expandableDirectoryPaths, true);
  }, [expandableDirectoryPaths, expandAll, model, query]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals an externally selected path in the Pierre tree model by expanding, selecting and scrolling
  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const selectedKind = entryKinds.get(selectedPath);
    if (selectedKind === undefined) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Refresh rebuilds treePaths; replaying handled reveals would close search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    const selectedTreePath = selectedKind === "directory" ? `${selectedPath}/` : selectedPath;
    const selectedItem = model.getItem(selectedTreePath);
    if (!selectedItem) return;

    // Reveal only external selections; tree selections are visible and re-revealing would close search.
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    setQuery("");
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory paths include trailing slashes; ancestor lookups must match.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if ("expand" in selectedItem) selectedItem.expand();
    selectedItem.select();
    model.scrollToPath(selectedTreePath, {
      focus: true,
      offset: "center",
    });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId]);

  // New entries from the header go in the focused folder, beside a focused file, or at the root.
  // The tree focuses its first row by default, so only a selected row picks the folder.
  const headerCreateDirectory = () => {
    const selected = model.getSelectedPaths().at(-1);
    if (!selected) return "";
    const path = stripSlash(selected);
    return newEntryDirectory({ kind: entryKinds.get(path) ?? "file", path });
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      data-glass-layer
      // Capture runs before the tree's shadow-internal row handler opens the menu.
      onContextMenuCapture={(event) => {
        contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
      }}
      // Capture dragstart before the tree selects the row so selection sees the drag flag.
      onDragStartCapture={(event) => dragMention.handleDragStart(event.nativeEvent)}
      onDragEnd={() => dragMention.handleDragEnd((path) => model.getItem(path)?.deselect())}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <HeaderIconButton
          label="New file"
          disabled={!canWrite}
          onClick={() => editing.startCreate("file", headerCreateDirectory())}
        >
          <FilePlusIcon className="size-3.5" />
        </HeaderIconButton>
        <HeaderIconButton
          label="New folder"
          disabled={!canWrite}
          onClick={() => editing.startCreate("directory", headerCreateDirectory())}
        >
          <FolderPlusIcon className="size-3.5" />
        </HeaderIconButton>
        <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        <FileSearchField
          inputRef={searchInputRef}
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={closeSearch}
        />
        {directoryPaths.length > 0 && !hostFolder ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    expandAll || allDirectoriesExpanded
                      ? "Collapse all folders"
                      : "Expand all folders"
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {expandAll || allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {searchScope !== null ? (
        <div className="flex h-7 shrink-0 items-center gap-1 px-3 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" dir="rtl">
            <bdi>Searching in {searchScope}/</bdi>
          </span>
          <HeaderIconButton label="Search all files" onClick={() => setSearchScope(null)}>
            <XIcon className="size-3.5" />
          </HeaderIconButton>
        </div>
      ) : null}
      {editing.error ? (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-1 px-3 py-1 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1 py-1 break-words">{editing.error}</span>
          <HeaderIconButton label="Dismiss" onClick={editing.dismissError}>
            <XIcon className="size-3.5" />
          </HeaderIconButton>
        </div>
      ) : null}
      {error || pathSearch.error ? (
        <button
          type="button"
          onClick={handleRefresh}
          className="p-4 text-left text-xs leading-relaxed text-destructive"
        >
          {error ?? pathSearch.error} Click to retry.
        </button>
      ) : null}
      {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      ) : null}
      {(!ready || pathSearch.isPending) && (
        <div
          role="status"
          className={
            entries.length > 0 && !hasNoSearchMatches
              ? "sr-only"
              : "px-3 py-1 text-xs text-muted-foreground"
          }
        >
          Loading files…
        </div>
      )}
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-file-tree-area
        onContextMenu={showBackgroundContextMenu}
        onKeyDownCapture={handleTreeKeyDown}
        onInputCapture={editing.captureTypedName}
        onDragOver={handleExternalDragOver}
        onDrop={handleExternalDrop}
      >
        {hasNoSearchMatches ? (
          ready && !isPending && !pathSearch.isPending && !error && !pathSearch.error ? (
            <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
              No matching files.
            </div>
          ) : null
        ) : (
          <FileTree
            model={model}
            aria-label={`${projectName} files`}
            className="min-h-0 flex-1 overflow-hidden"
            style={pierreTreeStyle(resolvedTheme)}
          />
        )}
      </div>
    </div>
  );
}
