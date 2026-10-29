import { enqueueNote } from "@t3tools/client-runtime/notes/outbox";
import { EnvironmentId, NoteDocument } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const hub = EnvironmentId.make("hub");
const decodeDocument = Schema.decodeSync(NoteDocument);
export const document = (body = "hub", revision = "b".repeat(64)) =>
  decodeDocument({
    id: "note-1",
    path: "note.md",
    folder: null,
    title: "Note",
    pinned: false,
    preview: "",
    related: [],
    card: null,
    body,
    updatedBy: "user",
    revision,
    updatedAt: "2026-10-19T00:00:00.000Z",
    size: body.length,
  });
export const edit = {
  environmentId: hub,
  path: "note.md",
  body: "mine",
  baseRevision: "a".repeat(64),
  localUpdatedAt: 1,
};
export const row = () => enqueueNote([], edit)[0]!;
