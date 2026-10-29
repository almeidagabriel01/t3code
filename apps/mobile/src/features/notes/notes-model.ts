import type { NoteOutboxRow } from "@t3tools/client-runtime/notes/outbox";
import type { NoteSummary } from "@t3tools/contracts";

export type NoteSyncState = "synced" | "pending" | "syncing" | "conflict";

export interface NoteListRow {
  readonly path: string;
  readonly title: string;
  readonly folder: string | null;
  readonly pinned: boolean;
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
export function newNotePath(input: string): string {
  const path = input.trim().normalize("NFC");
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}
