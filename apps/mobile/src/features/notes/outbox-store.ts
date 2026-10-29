import { NoteOutboxRow, restoreNote } from "@t3tools/client-runtime/notes/outbox";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { runtime } from "../../lib/runtime";
import { MobileDatabase } from "../../persistence/mobile-database";
import type { NotesOutboxStorage } from "./outbox-controller";

const decodeRow = Schema.decodeUnknownOption(Schema.fromJsonString(NoteOutboxRow));

export const notesOutboxStorage: NotesOutboxStorage = {
  load: () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* MobileDatabase;
        const payloads = yield* database.loadNoteOutbox;
        return payloads.flatMap((payload) => {
          const row = decodeRow(payload);
          // One unreadable row must not keep every other draft from syncing.
          if (Option.isNone(row)) console.warn("[notes] skipped an unreadable saved draft");
          return Option.isSome(row) ? [restoreNote(row.value)] : [];
        });
      }),
    ),
  save: (row) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* MobileDatabase;
        yield* database.saveNoteOutbox(
          row.environmentId,
          row.path,
          JSON.stringify(row),
          row.localUpdatedAt,
        );
      }),
    ),
  remove: (row) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* MobileDatabase;
        yield* database.removeNoteOutbox(row.environmentId, row.path);
      }),
    ),
};
