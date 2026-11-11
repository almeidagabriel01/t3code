import type { NoteOutboxRow } from "@t3tools/client-runtime/notes/outbox";
import { untitledNotePath } from "@t3tools/client-runtime/notes/title";
import type { EnvironmentId, NoteSummary, ProjectId } from "@t3tools/contracts";

export type NoteSyncState = "synced" | "pending" | "syncing" | "conflict";

export interface NoteListRow {
  readonly path: string;
  readonly title: string;
  readonly folder: string | null;
  readonly pinned: boolean;
  readonly project: string | null;
  readonly preview: string;
  readonly updatedAt: string;
  readonly sync: NoteSyncState;
  readonly group: string;
}

/** Server notes with this device's unsent drafts laid over them, in the web list's order. */
export function noteListRows(
  environmentId: string,
  notes: ReadonlyArray<NoteSummary>,
  outbox: ReadonlyArray<NoteOutboxRow>,
): ReadonlyArray<NoteListRow> {
  const rows = new Map<string, Omit<NoteListRow, "group">>(
    notes.map((note) => [
      note.path,
      {
        path: note.path,
        title: note.title,
        folder: note.folder,
        pinned: note.pinned,
        project: note.project ?? null,
        preview: note.preview,
        updatedAt: note.updatedAt,
        sync: noteSyncState(),
      },
    ]),
  );
  for (const row of outbox) {
    if (row.environmentId !== environmentId) continue;
    const previous = rows.get(row.path);
    rows.set(row.path, {
      path: row.path,
      title:
        /^#\s+(.+)$/m.exec(row.body)?.[1] ??
        previous?.title ??
        row.path.split("/").at(-1)!.slice(0, -".md".length),
      folder: row.path.includes("/") ? row.path.split("/")[0]! : null,
      pinned: previous?.pinned ?? false,
      project: previous?.project ?? row.project ?? null,
      preview: previous?.preview ?? "",
      updatedAt: previous?.updatedAt ?? "",
      sync: noteSyncState(row),
    });
  }
  // Pinned first, then loose notes, then folders by name; each most recently updated first.
  return [...rows.values()]
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (a.pinned ? 0 : (a.folder ?? "").localeCompare(b.folder ?? "")) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.title.localeCompare(b.title),
    )
    .map((row) => ({ ...row, group: row.pinned ? "Pinned" : (row.folder ?? "Notes") }));
}

/** Local drafts remain editable offline; delivery always checks a fresh server grant. */
export function canEditNoteDraft(allowed: boolean, connected: boolean, knownEnvironment: boolean) {
  return allowed || (knownEnvironment && !connected);
}

export function noteSyncState(row?: NoteOutboxRow): NoteSyncState {
  if (!row) return "synced";
  if (row.state === "conflict") return "conflict";
  return row.inFlight ? "syncing" : "pending";
}

export function noteSyncLabel(state: NoteSyncState) {
  switch (state) {
    case "pending":
      return "Saved on this device · syncs when connected";
    case "syncing":
      return "Syncing…";
    case "conflict":
      return "Needs your choice";
    case "synced":
      return null;
  }
}

/** A new note's path from what the person typed: `name` or `folder/name`, `.md` optional. */
function newNotePath(input: string): string {
  const path = input.trim().normalize("NFC");
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

/**
 * Where a new note goes: a typed folder/name as written, a bare name in the project's folder (the
 * root when there is none), and no name at all the next free Untitled there.
 */
export function newNoteTarget(
  input: string,
  folder: string | null,
  taken: ReadonlySet<string>,
): string {
  const name = input.trim();
  if (name === "") return untitledNotePath(taken, folder);
  return newNotePath(name.includes("/") || folder === null ? name : `${folder}/${name}`);
}

export type NoteRowActionId = "pin" | "start" | "rename" | "move" | "delete";

/** The long-press menu of a note row; empty when the connection allows none of them. */
export function noteRowMenuActions(
  note: { readonly pinned: boolean; readonly card: unknown; readonly issue?: unknown },
  can: { update: boolean; start: boolean; write: boolean; move: boolean; delete: boolean },
) {
  const actions: Array<{
    id: NoteRowActionId;
    title: string;
    image: string;
    attributes?: { destructive: true };
  }> = [];
  if (can.update && !note.issue)
    actions.push({
      id: "pin",
      title: note.pinned ? "Unpin" : "Pin to the top",
      image: note.pinned ? "pin.slash" : "pin",
    });
  if (can.start && !note.issue)
    actions.push({
      id: "start",
      title: note.card === null ? "Start work" : "Start another card",
      image: "hammer",
    });
  if (can.write && !note.issue) actions.push({ id: "rename", title: "Rename", image: "pencil" });
  if (can.move) actions.push({ id: "move", title: "Move or rename file", image: "folder" });
  if (can.delete)
    actions.push({
      id: "delete",
      title: "Delete",
      image: "trash",
      attributes: { destructive: true },
    });
  return actions;
}

/** The environment and project filter a Notes page opens on; a stale or missing environment falls back to the first. */
export function resolveNotesRoute(
  environmentIds: ReadonlyArray<EnvironmentId>,
  selected: EnvironmentId | null,
  params: { readonly environmentId: EnvironmentId; readonly project?: ProjectId } | undefined,
) {
  const environmentId =
    environmentIds.find((id) => id === (selected ?? params?.environmentId)) ??
    environmentIds[0] ??
    null;
  const initialProject =
    environmentId !== null && environmentId === params?.environmentId
      ? (params.project ?? null)
      : null;
  return { environmentId, initialProject };
}
