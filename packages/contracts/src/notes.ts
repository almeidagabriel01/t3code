import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { KanbanBoardId, KanbanCardId, KanbanColumnId } from "./kanban.ts";

/**
 * Notes are markdown files under the environment's notes directory. Folders only organise; the
 * hierarchy stops at one level, so a path is `note.md` or `folder/note.md`.
 */
const NOTE_PATH_MAX_LENGTH = 300;
/** A folder name, alone or as the first segment of a NotePath. */
const NOTE_FOLDER_MAX_LENGTH = 120;
/** Display titles travel in every summary, so a long first heading is cut to this many UTF-16 units. */
export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_PREVIEW_MAX_LENGTH = 140;
/** Bodies are documents a person edits, not attachments; the cap keeps a write one frame. */
export const NOTE_BODY_MAX_BYTES = 1024 * 1024;

const isNoteSegment = (segment: string) =>
  segment.length > 0 &&
  !segment.startsWith(".") &&
  segment.trim() === segment &&
  !/[\u0000-\u001f\u007f\\/:]/u.test(segment);

/** Canonical NFC, so two spellings of one name cannot address the same file twice. */
const isNfc = (value: string) => value === value.normalize("NFC");
const isFolderName = (value: string) =>
  isNfc(value) && value.length <= NOTE_FOLDER_MAX_LENGTH && isNoteSegment(value);

export const NoteFolder = Schema.String.check(
  Schema.makeFilter(isFolderName, {
    expected: "one folder name without slashes, leading dots, or control characters",
  }),
);
export type NoteFolder = typeof NoteFolder.Type;

export const NotePath = Schema.String.check(
  Schema.makeFilter(
    (value: string) => {
      if (!isNfc(value) || value.length > NOTE_PATH_MAX_LENGTH || !value.endsWith(".md"))
        return false;
      const segments = value.split("/");
      if (segments.length > 2) return false;
      if (segments.length === 2 && !isFolderName(segments[0]!)) return false;
      const file = segments.at(-1) ?? "";
      return segments.every(isNoteSegment) && file.length > ".md".length;
    },
    {
      expected: "a relative .md path with at most one folder, such as ideas.md or project/ideas.md",
    },
  ),
);
export type NotePath = typeof NotePath.Type;

/** Stable across moves; it also names the owner of the note's images. */
export const NoteId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)).pipe(
  Schema.brand("NoteId"),
);
export type NoteId = typeof NoteId.Type;

/** sha256 hex of the file's bytes. Edits made outside T3 Code change it too. */
export const NoteRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type NoteRevision = typeof NoteRevision.Type;

export const NoteAuthor = Schema.Literals(["user", "agent"]);
export type NoteAuthor = typeof NoteAuthor.Type;

/** The kanban card started from the note, on its environment-local project's board. */
export const NoteCardLink = Schema.Struct({
  cardId: KanbanCardId,
  projectId: ProjectId,
});
export type NoteCardLink = typeof NoteCardLink.Type;

/** Why a note cannot be edited by T3 Code. Its bytes stay on disk untouched. */
export const NoteIssue = Schema.Literals(["invalid_frontmatter", "invalid_utf8", "too_large"]);
export type NoteIssue = typeof NoteIssue.Type;

/** A file in the notes directory that is not listed as a note, so it is never silently missing. */
export const NoteSkipped = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(NOTE_PATH_MAX_LENGTH)),
  /** unsupported_name: not a plain NFC .md path with one folder at most. unreadable: could not be read. */
  reason: Schema.Literals(["unsupported_name", "unreadable"]),
});
export type NoteSkipped = typeof NoteSkipped.Type;

export const NoteSummary = Schema.Struct({
  /** null for a file that has never been written by T3 Code; the next write assigns one. */
  id: Schema.NullOr(NoteId),
  path: NotePath,
  folder: Schema.NullOr(NoteFolder),
  /** The first heading, else the first body line or file name, cut to NOTE_TITLE_MAX_LENGTH. */
  title: Schema.String.check(Schema.isMaxLength(NOTE_TITLE_MAX_LENGTH)),
  pinned: Schema.Boolean,
  preview: Schema.String.check(Schema.isMaxLength(NOTE_PREVIEW_MAX_LENGTH)),
  /** Threads linked for reference. */
  related: Schema.Array(ThreadId),
  card: Schema.NullOr(NoteCardLink),
  /** The environment-local project the note belongs to; absent means unscoped. */
  project: Schema.optionalKey(ProjectId),
  updatedBy: Schema.NullOr(NoteAuthor),
  /** Set when the file could not be understood; the note is read-only and metadata is not shown. */
  issue: Schema.optionalKey(NoteIssue),
  revision: NoteRevision,
  updatedAt: IsoDateTime,
  size: NonNegativeInt,
});
export type NoteSummary = typeof NoteSummary.Type;

export const NoteDocument = Schema.Struct({
  ...NoteSummary.fields,
  /** Markdown without the frontmatter, which the server owns. */
  body: Schema.String,
});
export type NoteDocument = typeof NoteDocument.Type;

export const NotesListInput = Schema.Struct({
  folder: Schema.optional(NoteFolder),
  /** Only notes of this project. */
  project: Schema.optional(ProjectId),
});
export type NotesListInput = typeof NotesListInput.Type;

export const NotesListResult = Schema.Struct({
  notes: Schema.Array(NoteSummary),
  folders: Schema.Array(NoteFolder),
  /** True when the folder holds more notes than one list returns. */
  truncated: Schema.Boolean,
  /** How many notes the truncated list left out. */
  omitted: Schema.optionalKey(NonNegativeInt),
  /** Files that are not listed as notes, at most 50. */
  skipped: Schema.optionalKey(Schema.Array(NoteSkipped)),
});
export type NotesListResult = typeof NotesListResult.Type;

export const NotesReadInput = Schema.Struct({ path: NotePath });
export type NotesReadInput = typeof NotesReadInput.Type;

export const NotesWriteInput = Schema.Struct({
  path: NotePath,
  body: Schema.String,
  /** The revision the edit started from; null creates the note and refuses when it exists. */
  baseRevision: Schema.NullOr(NoteRevision),
  /** Sets the project when given; absent keeps the current one. */
  project: Schema.optional(ProjectId),
});
export type NotesWriteInput = typeof NotesWriteInput.Type;

export const NotesUpdateInput = Schema.Struct({
  path: NotePath,
  pinned: Schema.optional(Schema.Boolean),
  relate: Schema.optional(ThreadId),
  unrelate: Schema.optional(ThreadId),
  /** null unlinks the kanban card; start work links one. */
  card: Schema.optional(Schema.Null),
  /** A project id moves the note there; null makes it unscoped. */
  project: Schema.optional(Schema.NullOr(ProjectId)),
});
export type NotesUpdateInput = typeof NotesUpdateInput.Type;

export const NotesMoveInput = Schema.Struct({
  from: NotePath,
  to: NotePath,
  baseRevision: NoteRevision,
});
export type NotesMoveInput = typeof NotesMoveInput.Type;

export const NotesDeleteInput = Schema.Struct({
  path: NotePath,
  baseRevision: NoteRevision,
});
export type NotesDeleteInput = typeof NotesDeleteInput.Type;

export const NotesDeleteResult = Schema.Struct({ path: NotePath });
export type NotesDeleteResult = typeof NotesDeleteResult.Type;

export const NotesSubscribeInput = Schema.Struct({});
export type NotesSubscribeInput = typeof NotesSubscribeInput.Type;

/** The first event is a snapshot; later ones change one note. Clients read bodies on demand. */
export const NotesEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    notes: Schema.Array(NoteSummary),
    folders: Schema.Array(NoteFolder),
    truncated: Schema.Boolean,
    omitted: Schema.optionalKey(NonNegativeInt),
    skipped: Schema.optionalKey(Schema.Array(NoteSkipped)),
  }),
  Schema.Struct({ type: Schema.Literal("upserted"), note: NoteSummary }),
  Schema.Struct({ type: Schema.Literal("removed"), path: NotePath }),
]);
export type NotesEvent = typeof NotesEvent.Type;

export const NotesStartWorkInput = Schema.Struct({
  path: NotePath,
  projectId: ProjectId,
  /** Defaults to the board's backlog column. */
  columnId: Schema.optional(KanbanColumnId),
  /** Stable per attempt: a retry with the same id returns the same card instead of a second one. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type NotesStartWorkInput = typeof NotesStartWorkInput.Type;

export const NotesStartWorkResult = Schema.Struct({
  note: NoteDocument,
  boardId: KanbanBoardId,
  cardId: KanbanCardId,
});
export type NotesStartWorkResult = typeof NotesStartWorkResult.Type;

export const NoteErrorReason = Schema.Literals([
  "not_found",
  "exists",
  "invalid_path",
  "too_large",
  /** An image in the body could not be stored, or the kanban card could not be created. */
  "invalid",
  "storage",
]);
export type NoteErrorReason = typeof NoteErrorReason.Type;

export class NoteError extends Schema.TaggedError<NoteError>()("NoteError", {
  reason: NoteErrorReason,
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

/**
 * The note changed since baseRevision. current is what is on disk now, so a person can compare
 * and choose, and an agent can re-read and retry.
 */
export class NoteConflictError extends Schema.TaggedError<NoteConflictError>()(
  "NoteConflictError",
  {
    path: NotePath,
    current: NoteDocument,
    message: Schema.String,
  },
) {}
