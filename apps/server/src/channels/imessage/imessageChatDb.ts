// @effect-diagnostics nodeBuiltinImport:off -- chat.db is a local SQLite file read with the built-in driver, read-only.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface ImessageRow {
  readonly rowid: number;
  readonly guid: string | null;
  readonly text: string | null;
  readonly attributedBody: Uint8Array | null;
  readonly is_from_me: number;
  readonly date: number;
  readonly associated_message_type: number | null;
  readonly item_type: number | null;
  readonly balloon_bundle_id: string | null;
  readonly cache_has_attachments: number | null;
  readonly message_service: string | null;
  readonly sender_handle: string | null;
  readonly sender_service: string | null;
  readonly chat_guid: string | null;
  readonly chat_identifier: string | null;
  readonly style: number | null;
  readonly chat_join_count: number;
}

export const ImessageDbCategory = Schema.Literals([
  "full_disk_access_missing",
  "messages_not_signed_in",
  "database_unavailable",
]);

export class ImessageDbError extends Schema.TaggedError<ImessageDbError>()("ImessageDbError", {
  category: ImessageDbCategory,
}) {}

export interface ImessageChatDb {
  readonly maxRowId: Effect.Effect<number, ImessageDbError>;
  readonly rowsAfter: (
    cursor: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ImessageRow>, ImessageDbError>;
  readonly rowById: (rowId: number) => Effect.Effect<ImessageRow | undefined, ImessageDbError>;
  readonly close: Effect.Effect<void>;
}

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : "");

/**
 * Why chat.db could not be read. The file existing but refusing to open is the Full Disk Access
 * prompt; a file that is not there means Messages never set up an account on this Mac.
 */
export function classifyImessageDbFailure(cause: unknown): ImessageDbError["category"] {
  const code = codeOf(cause);
  if (code === "ENOENT") return "messages_not_signed_in";
  if (
    /EACCES|EPERM|SQLITE_CANTOPEN/.test(code) ||
    /unable to open|authorization denied|not permitted/i.test(messageOf(cause))
  ) {
    return "full_disk_access_missing";
  }
  return "database_unavailable";
}

// Modern dates are nanoseconds past 2^53, which node:sqlite refuses to read as an integer.
const SELECT = `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.is_from_me,
  CAST(m.date AS REAL) AS date,
  m.associated_message_type, m.item_type, m.balloon_bundle_id, m.cache_has_attachments,
  m.service AS message_service, h.id AS sender_handle, h.service AS sender_service,
  c.guid AS chat_guid, c.chat_identifier, c.style,
  (SELECT COUNT(*) FROM chat_message_join AS j WHERE j.message_id = m.ROWID) AS chat_join_count
  FROM message AS m
  LEFT JOIN handle AS h ON h.ROWID = m.handle_id
  LEFT JOIN chat AS c ON c.ROWID = (
    SELECT MIN(j.chat_id) FROM chat_message_join AS j WHERE j.message_id = m.ROWID
  )`;

/** Opens the file read-only; nothing here can write to it. */
export const openImessageChatDb = (file: string) =>
  Effect.try({
    try: () => {
      NodeFS.statSync(file);
      return new NodeSqlite.DatabaseSync(file, { readOnly: true, timeout: 500 });
    },
    catch: (cause) => new ImessageDbError({ category: classifyImessageDbFailure(cause) }),
  }).pipe(
    Effect.map((db): ImessageChatDb => {
      const query = <A>(run: () => A) =>
        Effect.try({
          try: run,
          catch: () => new ImessageDbError({ category: "database_unavailable" }),
        });
      return {
        maxRowId: query(() => {
          const row = db.prepare("SELECT MAX(ROWID) AS max FROM message").get();
          return Number(row?.max ?? 0);
        }),
        rowsAfter: (cursor, limit) =>
          query(
            () =>
              db
                .prepare(`${SELECT} WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?`)
                .all(cursor, limit) as unknown as ReadonlyArray<ImessageRow>,
          ),
        rowById: (rowId) =>
          query(
            () =>
              db.prepare(`${SELECT} WHERE m.ROWID = ?`).get(rowId) as unknown as
                | ImessageRow
                | undefined,
          ),
        close: Effect.sync(() => {
          try {
            db.close();
          } catch {
            // The handle is already unusable; nothing is left to release.
          }
        }),
      };
    }),
  );
