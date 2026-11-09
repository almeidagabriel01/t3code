// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure posix path cleanup, no filesystem.
import * as NodePath from "node:path";

export const MAX_TASK_RESOURCES = 8;
const MAX_RESOURCE_CHARS = 200;

/** "folder:<path>" holds a directory tree; anything else is an id, compared whole and by lowercase. */
const FOLDER = /^folder\s*:\s*(.+)$/i;

/** Trimmed, deduped and capped; folders cleaned of `./`, `..` and trailing slashes, ids lowercased. */
export function normalizeResources(raw: ReadonlyArray<string>): ReadonlyArray<string> {
  const out: string[] = [];
  for (const entry of raw) {
    const text = entry.trim();
    const folder = FOLDER.exec(text);
    const cleaned =
      folder === null
        ? text.toLowerCase().replace(/\s+/g, "-")
        : `folder:${NodePath.posix.normalize(folder[1]!.trim()).replace(/(.)\/+$/, "$1")}`;
    if (cleaned === "" || cleaned === "folder:" || out.includes(cleaned)) continue;
    out.push(cleaned.slice(0, MAX_RESOURCE_CHARS));
    if (out.length === MAX_TASK_RESOURCES) break;
  }
  return out;
}

const folderOf = (resource: string) => (resource.startsWith("folder:") ? resource.slice(7) : null);

/** A folder overlaps itself and everything under it; any other resource only itself. */
export function resourcesOverlap(a: string, b: string): boolean {
  const left = folderOf(a);
  const right = folderOf(b);
  if (left === null || right === null) return a === b;
  const under = (inner: string, outer: string) =>
    inner === outer || outer === "/" || outer === "." || inner.startsWith(`${outer}/`);
  return under(left, right) || under(right, left);
}

/** The first of `wanted` that overlaps one held, with who holds it. */
export function firstConflict(
  wanted: ReadonlyArray<string>,
  held: ReadonlyMap<string, string>,
): { readonly resource: string; readonly holder: string } | null {
  for (const resource of wanted) {
    for (const [other, holder] of held) {
      if (resourcesOverlap(resource, other)) return { resource, holder };
    }
  }
  return null;
}
