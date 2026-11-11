import type { DroppedFile } from "./useFileTreeEditing";

/** True for drags from Finder or the desktop, which carry files rather than tree rows. */
export function isExternalFileDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer !== null && [...dataTransfer.types].includes("Files");
}

const readDirectory = (directory: FileSystemDirectoryEntry) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => {
    const reader = directory.createReader();
    const entries: FileSystemEntry[] = [];
    // readEntries returns a batch at a time and an empty batch at the end.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(entries);
        else {
          entries.push(...batch);
          next();
        }
      }, reject);
    next();
  });

const readFile = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

async function collectEntry(entry: FileSystemEntry, prefix: string, into: DroppedFile[]) {
  const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
  if (entry.isFile) {
    into.push({ relativePath, file: await readFile(entry as FileSystemFileEntry) });
    return;
  }
  if (!entry.isDirectory) return;
  for (const child of await readDirectory(entry as FileSystemDirectoryEntry)) {
    await collectEntry(child, relativePath, into);
  }
}

/**
 * Lists dropped files with their paths, folders included. Entries are read before the first
 * await: the browser empties the drop's item list once the handler yields.
 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const items = [...dataTransfer.items].filter((item) => item.kind === "file");
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
  const files = items.map((item) => item.getAsFile());
  const collected: DroppedFile[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry) await collectEntry(entry, "", collected);
    else {
      const file = files[index];
      if (file) collected.push({ relativePath: file.name, file });
    }
  }
  return collected;
}

/** The folder a drop lands in: the folder row under the pointer, a file row's folder, or the root. */
export function dropTargetDirectory(composedPath: readonly EventTarget[]): string {
  for (const target of composedPath) {
    if (!(target instanceof HTMLElement)) continue;
    const path = target.getAttribute("data-item-path");
    if (path === null) continue;
    const clean = path.replace(/\/$/, "");
    if (target.getAttribute("data-item-type") === "folder") return clean;
    const slash = clean.lastIndexOf("/");
    return slash < 0 ? "" : clean.slice(0, slash);
  }
  return "";
}

/** True when the pointer is over a tree row rather than empty space. */
export function isOverTreeRow(composedPath: readonly EventTarget[]): boolean {
  return composedPath.some(
    (target) => target instanceof HTMLElement && target.hasAttribute("data-item-path"),
  );
}
