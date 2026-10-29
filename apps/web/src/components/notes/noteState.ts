import {
  NoteConflictError,
  NotePath,
  type NoteDocument,
  type NoteFolder,
  type NoteSummary,
  type NotesWriteInput,
} from "@t3tools/contracts";
import { attachmentImageIds, replaceAttachmentImageIds } from "@t3tools/shared/attachmentImageRefs";
import * as Schema from "effect/Schema";

const isConflict = Schema.is(NoteConflictError);
const isNotePath = Schema.is(NotePath);

const byRecent = (left: NoteSummary, right: NoteSummary) =>
  right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path);

export interface NoteGroups {
  readonly pinned: ReadonlyArray<NoteSummary>;
  /** Notes at the top level, outside any folder. */
  readonly loose: ReadonlyArray<NoteSummary>;
  readonly folders: ReadonlyArray<{ folder: NoteFolder; notes: ReadonlyArray<NoteSummary> }>;
}

/** Pinned notes first whatever their folder, then loose notes, then folders by name. */
export function groupNotes(
  notes: ReadonlyArray<NoteSummary>,
  folders: ReadonlyArray<NoteFolder> = [],
): NoteGroups {
  const byFolder = new Map<NoteFolder, NoteSummary[]>(folders.map((folder) => [folder, []]));
  const pinned: NoteSummary[] = [];
  const loose: NoteSummary[] = [];
  for (const note of notes) {
    if (note.pinned) pinned.push(note);
    else if (note.folder === null) loose.push(note);
    else byFolder.set(note.folder, [...(byFolder.get(note.folder) ?? []), note]);
  }
  return {
    pinned: pinned.toSorted(byRecent),
    loose: loose.toSorted(byRecent),
    folders: [...byFolder]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([folder, entries]) => ({ folder, notes: entries.toSorted(byRecent) })),
  };
}

const searchable = (value: string) => value.normalize("NFC").toLocaleLowerCase();

/** Every whitespace-separated term must appear in the title, preview, or path. */
export function filterNotes(
  notes: ReadonlyArray<NoteSummary>,
  query: string,
): ReadonlyArray<NoteSummary> {
  const terms = searchable(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return notes;
  return notes.filter((note) => {
    const haystack = searchable(`${note.title}\n${note.preview}\n${note.path}`);
    return terms.every((term) => haystack.includes(term));
  });
}

/** A query that names a note the list does not hold, such as one past a truncated list. */
export function openablePath(notes: ReadonlyArray<NoteSummary>, query: string): string | null {
  const path = query.trim().normalize("NFC");
  return isNotePath(path) && !notes.some((note) => note.path === path) ? path : null;
}

/** Untitled.md, Untitled 2.md, ...; skip lets a retry step past a name taken since the list loaded. */
export function untitledNotePath(
  taken: ReadonlySet<string>,
  folder: string | null,
  skip = 0,
): string {
  const prefix = folder ? `${folder}/` : "";
  let skipped = 0;
  for (let index = 1; ; index++) {
    const path = `${prefix}Untitled${index === 1 ? "" : ` ${index}`}.md`;
    if (taken.has(path)) continue;
    if (skipped++ === skip) return path;
  }
}

export type NoteReply<A> = { ok: true; value: A } | { ok: false; error: unknown };

export function noteErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string" &&
        error.message
      ? error.message
      : "The note request failed. Try again.";
}

export function isNoteErrorReason(error: unknown, reason: string): boolean {
  return (
    typeof error === "object" && error !== null && "reason" in error && error.reason === reason
  );
}

/**
 * The ids the server gave uploaded images when it saved them, read by pairing the image refs of
 * the sent and saved bodies. Null when the bodies differ in anything else.
 */
export function claimedImageIds(sent: string, saved: string): ReadonlyMap<string, string> | null {
  const from = attachmentImageIds(sent);
  const to = attachmentImageIds(saved);
  if (from.length !== to.length) return null;
  const ids = new Map<string, string>();
  from.forEach((id, index) => {
    if (id !== to[index]) ids.set(id, to[index]!);
  });
  return ids.size > 0 && replaceAttachmentImageIds(sent, ids) === saved ? ids : null;
}

export interface NoteEditState {
  readonly document: NoteDocument;
  readonly body: string;
  readonly incoming: NoteDocument | null;
  readonly saving: boolean;
  readonly refreshing: boolean;
  readonly refreshError: string | null;
  readonly error: string | null;
  /** Bumped when the body is replaced from outside, so the editor reloads it. */
  readonly editorVersion: number;
  /** Image ids the server assigned; the editor renames its nodes in place when this changes. */
  readonly claimedImages: ReadonlyMap<string, string>;
}

export function isNoteDirty(state: NoteEditState): boolean {
  return state.body !== state.document.body;
}

/** Pinning and linking rewrite only the header, so the draft can move onto the new revision. */
function isHeaderOnlyChange(next: NoteDocument, base: NoteDocument): boolean {
  return next.body === base.body;
}

const EMPTY_IDS: ReadonlyMap<string, string> = new Map();

// Save acknowledgements advance the base, never replace edits typed while the request was in flight.
export class NoteSession {
  private state: NoteEditState;
  private listeners = new Set<() => void>();
  private readSequence = 0;
  constructor(
    document: NoteDocument,
    private write: (input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>,
    private read?: () => Promise<NoteReply<NoteDocument>>,
  ) {
    this.state = {
      document,
      body: document.body,
      incoming: null,
      saving: false,
      refreshing: false,
      refreshError: null,
      error: null,
      editorVersion: 0,
      claimedImages: EMPTY_IDS,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: NoteEditState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  edit(body: string) {
    // An editor that has not renamed its images yet must not send the upload ids again.
    const claimed = replaceAttachmentImageIds(body, this.state.claimedImages);
    if (claimed === this.state.body && this.state.error === null) return;
    this.update({ ...this.state, body: claimed, error: null });
  }
  receive(document: NoteDocument) {
    const state = this.state;
    if (document.revision === state.document.revision) {
      this.update({ ...state, document, refreshError: null });
    } else if (state.saving) {
      this.update({ ...state, incoming: document });
    } else if (isHeaderOnlyChange(document, state.document)) {
      this.update({ ...state, document, incoming: null, refreshError: null });
    } else if (isNoteDirty(state)) {
      this.update({ ...state, incoming: document });
    } else {
      this.update({
        ...state,
        document,
        body: document.body,
        incoming: null,
        editorVersion: state.editorVersion + 1,
        error: null,
      });
    }
  }
  async refresh(read: (() => Promise<NoteReply<NoteDocument>>) | undefined = this.read) {
    if (!read) return;
    const sequence = ++this.readSequence;
    const baseRevision = this.state.document.revision;
    this.update({ ...this.state, refreshing: true, refreshError: null });
    const result = await read().catch((error: unknown): NoteReply<NoteDocument> => ({
      ok: false,
      error,
    }));
    // A save acknowledged after this read began owns the newer base. Read again so an
    // intervening external edit is still seen, without trusting a response from the old base.
    if (sequence !== this.readSequence) return;
    this.update({ ...this.state, refreshing: false });
    if (baseRevision !== this.state.document.revision) {
      if (!result.ok || result.value.revision !== this.state.document.revision)
        await this.refresh(read);
      return;
    }
    if (result.ok) this.receive(result.value);
    else this.update({ ...this.state, refreshError: noteErrorMessage(result.error) });
  }
  compare(current: NoteDocument) {
    this.update({ ...this.state, incoming: current, error: null });
  }
  acceptTheirs() {
    if (!this.state.incoming || this.state.saving) return;
    const document = this.state.incoming;
    this.update({
      ...this.state,
      document,
      body: document.body,
      incoming: null,
      error: null,
      editorVersion: this.state.editorVersion + 1,
    });
  }
  async keepMine() {
    if (!this.state.incoming || this.state.saving) return;
    this.update({ ...this.state, document: this.state.incoming, incoming: null, error: null });
    await this.save();
  }
  async save(expectedBody?: string, retried = false) {
    const before = this.state;
    if (
      before.saving ||
      before.incoming ||
      !isNoteDirty(before) ||
      (expectedBody !== undefined && expectedBody !== before.body)
    )
      return;
    const input = {
      path: before.document.path,
      body: before.body,
      baseRevision: before.document.revision,
    };
    this.update({ ...before, saving: true, error: null });
    const result = await this.write(input).catch((error: unknown): NoteReply<NoteDocument> => ({
      ok: false,
      error,
    }));
    const latest = this.state;
    if (result.ok) {
      const saved = result.value;
      // Revisions are hashes with no order, so an event that arrived mid-save is settled by a reread.
      const crossed = latest.incoming !== null && latest.incoming.revision !== saved.revision;
      const ids = saved.body === input.body ? null : claimedImageIds(input.body, saved.body);
      const claimedImages = ids ? new Map([...latest.claimedImages, ...ids]) : latest.claimedImages;
      // Any other rewrite of an untouched draft is taken as saved, or the next save would undo it.
      const adopt = ids === null && saved.body !== input.body && latest.body === input.body;
      this.update({
        ...latest,
        document: saved,
        body: adopt ? saved.body : replaceAttachmentImageIds(latest.body, claimedImages),
        editorVersion: adopt ? latest.editorVersion + 1 : latest.editorVersion,
        claimedImages,
        saving: false,
        incoming: null,
      });
      if (crossed) {
        if (this.read) await this.refresh();
        else this.update({ ...this.state, incoming: latest.incoming });
      }
    } else if (
      !retried &&
      isConflict(result.error) &&
      isHeaderOnlyChange(result.error.current, before.document)
    ) {
      this.update({
        ...latest,
        document: result.error.current,
        incoming: null,
        saving: false,
        error: null,
      });
      await this.save(undefined, true);
    } else {
      this.update({
        ...latest,
        saving: false,
        incoming: isConflict(result.error) ? result.error.current : latest.incoming,
        error: isConflict(result.error) ? null : noteErrorMessage(result.error),
      });
    }
  }
}
