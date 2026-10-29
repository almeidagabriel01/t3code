import {
  KanbanCardId,
  NoteId,
  ProjectId,
  ThreadId,
  type NoteAuthor,
  type NoteCardLink,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { isMap, isSeq, parseDocument, stringify, type Document } from "yaml";

const isNoteId = Schema.is(NoteId);

export interface NoteContents {
  readonly body: string;
  /** null until T3 Code first writes the file. */
  readonly id: NoteId | null;
  readonly pinned: boolean;
  readonly related: ReadonlyArray<ThreadId>;
  readonly card: NoteCardLink | null;
  readonly updatedBy: NoteAuthor | null;
  /** The parsed header, so keys this module does not manage survive a write. */
  readonly metadata: Document | null;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export function parseNote(contents: string): NoteContents {
  const candidate = /^(?:﻿)?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/mu.exec(contents);
  const match = candidate?.index === 0 ? candidate : null;
  const metadata = match ? parseDocument(match[1]!, { uniqueKeys: true }) : null;
  if (
    metadata &&
    (metadata.errors.length > 0 || (metadata.contents !== null && !isMap(metadata.contents)))
  )
    throw new Error("Invalid note frontmatter");
  const id = metadata?.get("id");
  const updatedBy = metadata?.get("updatedBy");
  const relatedNode = metadata?.get("related", true);
  const related: unknown = isSeq(relatedNode) ? relatedNode.toJSON() : [];
  const cardId = text(metadata?.get("card"));
  const projectId = text(metadata?.get("cardProject"));
  return {
    body: match ? contents.slice(match[0].length) : contents,
    id: isNoteId(id) ? id : null,
    pinned: metadata?.get("pinned") === true,
    related: (Array.isArray(related) ? related : []).flatMap((entry: unknown) => {
      const threadId = text(entry);
      return threadId === null ? [] : [ThreadId.make(threadId)];
    }),
    card:
      cardId !== null && projectId !== null
        ? { cardId: KanbanCardId.make(cardId), projectId: ProjectId.make(projectId) }
        : null,
    updatedBy: updatedBy === "user" || updatedBy === "agent" ? updatedBy : null,
    metadata,
  };
}

export function serializeNote(note: NoteContents): string {
  const metadata = note.metadata?.clone();
  const fields = {
    ...(note.id === null ? {} : { id: note.id }),
    ...(note.pinned ? { pinned: true } : {}),
    ...(note.related.length > 0 ? { related: [...note.related] } : {}),
    ...(note.card === null ? {} : { card: note.card.cardId, cardProject: note.card.projectId }),
    updatedBy: note.updatedBy,
  };
  if (isMap(metadata?.contents)) {
    if (!note.pinned) metadata.delete("pinned");
    if (note.related.length === 0) metadata.delete("related");
    if (note.card === null) {
      metadata.delete("card");
      metadata.delete("cardProject");
    }
  }
  if (metadata) for (const [key, value] of Object.entries(fields)) metadata.set(key, value);
  return `---\n${metadata ? metadata.toString() : stringify(fields)}---\n${note.body}`;
}
