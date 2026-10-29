import {
  KanbanCardId,
  NoteId,
  ProjectId,
  ThreadId,
  type NoteAuthor,
  type NoteCardLink,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { isMap, isScalar, isSeq, parseDocument, stringify, type Document } from "yaml";

const isNoteId = Schema.is(NoteId);

export interface NoteContents {
  readonly body: string;
  /** null until T3 Code first writes the file. */
  readonly id: NoteId | null;
  readonly pinned: boolean;
  readonly related: ReadonlyArray<ThreadId>;
  readonly card: NoteCardLink | null;
  readonly project: ProjectId | null;
  readonly updatedBy: NoteAuthor | null;
  /** The parsed header, so keys this module does not manage survive a write. */
  readonly metadata: Document | null;
}

/** The header exists but cannot be understood, so a write could not preserve it. */
export class InvalidFrontmatterError extends Error {
  override readonly name = "InvalidFrontmatterError";
}

/** A string, or a number a person typed where a string belongs (`card: 1234`). */
const text = (value: unknown) =>
  typeof value === "string"
    ? value.trim() || null
    : (typeof value === "number" && Number.isFinite(value)) || typeof value === "bigint"
      ? String(value)
      : null;

const TRUTHY = new Set(["true", "yes", "on", "y", "1"]);
const flag = (value: unknown) =>
  value === true ||
  value === 1 ||
  (typeof value === "string" && TRUTHY.has(value.trim().toLowerCase()));

type Managed = Pick<NoteContents, "id" | "pinned" | "related" | "card" | "project" | "updatedBy">;

/** Reads the managed keys tolerantly: scalars, single values and lists are all understood. */
function readManaged(metadata: Document | null): Managed {
  const id = text(metadata?.get("id"));
  const updatedBy = metadata?.get("updatedBy");
  const relatedNode = metadata?.get("related", true);
  const related: unknown = isSeq(relatedNode)
    ? relatedNode.toJSON()
    : isScalar(relatedNode)
      ? [relatedNode.value]
      : [];
  const cardId = text(metadata?.get("card"));
  const projectId = text(metadata?.get("cardProject"));
  const scope = text(metadata?.get("project"));
  return {
    id: id !== null && isNoteId(id) ? id : null,
    pinned: flag(metadata?.get("pinned")),
    related: (Array.isArray(related) ? related : []).flatMap((entry: unknown) => {
      const threadId = text(entry);
      return threadId === null ? [] : [ThreadId.make(threadId)];
    }),
    card:
      cardId !== null && projectId !== null
        ? { cardId: KanbanCardId.make(cardId), projectId: ProjectId.make(projectId) }
        : null,
    project: scope === null ? null : ProjectId.make(scope),
    updatedBy: updatedBy === "user" || updatedBy === "agent" ? updatedBy : null,
  };
}

/** Throws InvalidFrontmatterError for a header that is not a YAML map with unique keys. */
export function parseNote(contents: string): NoteContents {
  const candidate = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/mu.exec(
    contents,
  );
  const match = candidate?.index === 0 ? candidate : null;
  const metadata = match ? parseDocument(match[1]!, { uniqueKeys: true }) : null;
  if (metadata && metadata.errors.length > 0)
    throw new InvalidFrontmatterError("Invalid note frontmatter");
  // A block that is plain YAML but not a map (`---`, a sentence, `---`) is markdown, not a header.
  const header =
    metadata && (metadata.contents === null || isMap(metadata.contents)) ? metadata : null;
  return {
    body: header && match ? contents.slice(match[0].length) : contents,
    ...readManaged(header),
    metadata: header,
  };
}

const sameCard = (a: NoteCardLink | null, b: NoteCardLink | null) =>
  a === b || (a !== null && b !== null && a.cardId === b.cardId && a.projectId === b.projectId);
const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

/**
 * Writes only the keys whose value differs from what the header already says, so an
 * un-understood value (`related: thread-1`, `pinned: yes`, `card` without `cardProject`) survives
 * every write that did not change that field.
 */
export function serializeNote(note: NoteContents): string {
  const metadata = note.metadata?.clone() ?? null;
  const base = readManaged(metadata);
  const fields = {
    ...(note.id === null ? {} : { id: note.id }),
    ...(note.pinned ? { pinned: true } : {}),
    ...(note.related.length > 0 ? { related: [...note.related] } : {}),
    ...(note.card === null ? {} : { card: note.card.cardId, cardProject: note.card.projectId }),
    ...(note.project === null ? {} : { project: note.project }),
    updatedBy: note.updatedBy,
  };
  if (!metadata) return `---\n${stringify(fields)}---\n${note.body}`;
  if (note.id !== base.id && note.id !== null) metadata.set("id", note.id);
  if (note.pinned !== base.pinned)
    if (note.pinned) metadata.set("pinned", true);
    else metadata.delete("pinned");
  if (!sameList(note.related, base.related))
    if (note.related.length > 0) metadata.set("related", [...note.related]);
    else metadata.delete("related");
  if (!sameCard(note.card, base.card))
    if (note.card) {
      metadata.set("card", note.card.cardId);
      metadata.set("cardProject", note.card.projectId);
    } else {
      metadata.delete("card");
      metadata.delete("cardProject");
    }
  if (note.project !== base.project)
    if (note.project !== null) metadata.set("project", note.project);
    else metadata.delete("project");
  if (note.updatedBy !== base.updatedBy) metadata.set("updatedBy", note.updatedBy);
  return `---\n${metadata.toString()}---\n${note.body}`;
}
