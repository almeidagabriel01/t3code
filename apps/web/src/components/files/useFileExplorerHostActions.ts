import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
} from "@t3tools/client-runtime/state/projects";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import JSZip from "jszip";

import { toastManager } from "~/components/ui/toast";
import { useThreadTerminalActions } from "~/components/terminal/useThreadTerminalActions";
import { downloadMedia, readMediaBlob } from "~/components/media/mediaContent";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { newProjectId } from "~/lib/utils";
import { assetEnvironment } from "~/state/assets";
import { readProjects } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { joinHostPath } from "./filePath";

/** Explorer actions that need the thread or another panel; a missing one hides its menu item. */
export interface FileExplorerHostActions {
  readonly openInTerminal?: (absolutePath: string) => void;
  readonly openInBrowser?: (relativePath: string) => void;
  readonly openMarkdownPreview?: (relativePath: string) => void;
  readonly addAsProject?: (absolutePath: string) => void;
  readonly download?: (relativePath: string, kind: "file" | "directory") => void;
}

// ponytail: folder downloads are zipped in the browser, so they stop at these limits; a server-side zip stream lifts them.
const FOLDER_DOWNLOAD_MAX_FILES = 2_000;
const FOLDER_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

const leafName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || "folder";

export function useFileExplorerHostActions(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
}): Pick<FileExplorerHostActions, "openInTerminal" | "addAsProject" | "download"> {
  const terminalActions = useThreadTerminalActions(input.threadRef);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const fail = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });

  const assetUrl = async (relativePath: string) => {
    const connection = readPreparedConnection(input.environmentId);
    if (!connection) throw new Error("Reconnect to this environment and try again.");
    const result = await createAssetUrl({
      environmentId: input.environmentId,
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: input.threadRef.threadId,
          path: joinHostPath(input.cwd, relativePath),
        },
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("The environment returned an invalid file URL.");
    return url;
  };

  const listFiles = async (directory: string) => {
    const files: string[] = [];
    const queue = [directory];
    while (queue.length > 0) {
      const directoryPath = queue.shift()!;
      const result = await executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.listEntries({
          environmentId: input.environmentId,
          input: { cwd: input.cwd, directoryPath },
        }),
        { refresh: true, reportFailure: false, reportDefect: false },
      );
      if (result._tag !== "Success") throw new Error(`Could not list ${directoryPath}.`);
      for (const entry of result.value.entries) {
        if (entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) !== directoryPath)
          continue;
        if (entry.kind === "directory") queue.push(entry.path);
        else files.push(entry.path);
        if (files.length > FOLDER_DOWNLOAD_MAX_FILES) {
          throw new Error(`The folder has more than ${FOLDER_DOWNLOAD_MAX_FILES} files.`);
        }
      }
    }
    return files;
  };

  const downloadFolder = async (directory: string) => {
    const zip = new JSZip();
    let bytes = 0;
    for (const path of await listFiles(directory)) {
      const blob = await readMediaBlob(await assetUrl(path));
      bytes += blob.size;
      if (bytes > FOLDER_DOWNLOAD_MAX_BYTES) throw new Error("The folder is larger than 200 MB.");
      zip.file(path.slice(directory.length + 1), blob);
    }
    const url = URL.createObjectURL(await zip.generateAsync({ type: "blob" }));
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${leafName(directory)}.zip`;
      anchor.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  };

  return {
    openInTerminal: (absolutePath) => {
      const launched = terminalActions.launchTerminal({
        place: (terminalId) =>
          useRightPanelStore.getState().openTerminal(input.threadRef, terminalId),
        location: { cwd: absolutePath, worktreePath: null },
      });
      if (!launched) {
        toastManager.add({ type: "error", title: "Could not open a terminal here" });
      }
    },
    addAsProject: (absolutePath) => {
      void (async () => {
        const existing = findProjectByPath(
          readProjects().filter((project) => project.environmentId === input.environmentId),
          absolutePath,
        );
        if (existing) {
          toastManager.add({
            type: "info",
            title: "Already a project",
            description: existing.title,
          });
          return;
        }
        const result = await createProject({
          environmentId: input.environmentId,
          input: {
            projectId: newProjectId(),
            title: inferProjectTitleFromPath(absolutePath),
            workspaceRoot: absolutePath,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          fail("Could not add the project", squashAtomCommandFailure(result));
          return;
        }
        toastManager.add({ type: "success", title: "Project added", description: absolutePath });
      })();
    },
    download: (relativePath, kind) => {
      toastManager.add({ type: "info", title: `Preparing ${leafName(relativePath)}…` });
      void (async () => {
        try {
          if (kind === "directory") await downloadFolder(relativePath);
          else await downloadMedia(await assetUrl(relativePath), leafName(relativePath));
        } catch (error) {
          fail("Download failed", error);
        }
      })();
    },
  };
}
