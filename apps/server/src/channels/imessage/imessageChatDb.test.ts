// @effect-diagnostics nodeBuiltinImport:off -- synthetic SQLite file fixture in a temporary directory only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { classifyImessageDbFailure, openImessageChatDb } from "./imessageChatDb.ts";

const SCHEMA = `CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
  is_from_me INTEGER, date INTEGER, associated_message_type INTEGER, item_type INTEGER,
  balloon_bundle_id TEXT, cache_has_attachments INTEGER, service TEXT, account TEXT);
  CREATE TABLE handle (id TEXT, service TEXT);
  CREATE TABLE chat (guid TEXT, chat_identifier TEXT, style INTEGER);
  CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);`;

/** A 2026 date as modern macOS stores it: nanoseconds since 2001, past `Number.MAX_SAFE_INTEGER`. */
const APPLE_NANOSECONDS = 815_273_906_249_017_984n;

const withDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-imsg-db-"))),
    use,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

describe("classifyImessageDbFailure", () => {
  const rows: ReadonlyArray<readonly [string, unknown, string]> = [
    ["missing file", { code: "ENOENT" }, "messages_not_signed_in"],
    ["permission", { code: "EPERM" }, "full_disk_access_missing"],
    ["access", { code: "EACCES" }, "full_disk_access_missing"],
    ["cannot open", { code: "SQLITE_CANTOPEN" }, "full_disk_access_missing"],
    [
      "unable to open message",
      new Error("unable to open database file"),
      "full_disk_access_missing",
    ],
    ["authorization message", new Error("authorization denied"), "full_disk_access_missing"],
    ["anything else", new Error("database is locked"), "database_unavailable"],
    ["not an error", "boom", "database_unavailable"],
  ];
  it.each(rows)("%s", (_name, cause, category) => {
    expect(classifyImessageDbFailure(cause)).toBe(category);
  });
});

describe("read-only chat database", () => {
  it.effect("reads rows in order with join counts, and cannot write", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const file = NodePath.join(dir, "fixture.sqlite");
        yield* Effect.sync(() => {
          const writer = new NodeSqlite.DatabaseSync(file);
          writer.exec(SCHEMA);
          writer.exec(
            "INSERT INTO handle VALUES ('+15550000000','iMessage'); INSERT INTO chat VALUES ('iMessage;-;+15550000000','+15550000000',45);",
          );
          for (let i = 1; i <= 3; i++) {
            writer
              .prepare(
                "INSERT INTO message (guid,text,handle_id,is_from_me,date,item_type,service) VALUES (?,?,?,?,?,?,?)",
              )
              .run(`g${i}`, "hello", 1, 0, i === 1 ? APPLE_NANOSECONDS : 0, 0, "iMessage");
          }
          writer.exec(
            "INSERT INTO chat_message_join VALUES (2,1); INSERT INTO chat_message_join VALUES (3,1); INSERT INTO chat_message_join VALUES (3,1);",
          );
          writer
            .prepare("UPDATE message SET attributedBody = ? WHERE ROWID = 1")
            .run(new Uint8Array([0, 255, 1]));
          writer.close();
        });
        const db = yield* openImessageChatDb(file);
        assert.equal(yield* db.maxRowId, 3);
        const rows = yield* db.rowsAfter(0, 2);
        assert.deepEqual(
          rows.map((row) => row.rowid),
          [1, 2],
        );
        assert.deepEqual(rows[0]?.attributedBody, new Uint8Array([0, 255, 1]));
        assert.equal(rows[0]?.date, Number(APPLE_NANOSECONDS));
        assert.include(rows[1], {
          chat_join_count: 1,
          chat_guid: "iMessage;-;+15550000000",
          sender_handle: "+15550000000",
          message_service: "iMessage",
          style: 45,
        });
        assert.equal((yield* db.rowById(1))?.chat_join_count, 0);
        assert.equal((yield* db.rowById(3))?.chat_join_count, 2);
        assert.isUndefined(yield* db.rowById(99));
        yield* db.close;
        yield* db.close;
      }),
    ),
  );

  it.effect("reports a missing file, a damaged file and a schema it does not know", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const missing = yield* Effect.flip(openImessageChatDb(NodePath.join(dir, "none")));
        assert.equal(missing.category, "messages_not_signed_in");
        const empty = NodePath.join(dir, "empty.sqlite");
        yield* Effect.sync(() => {
          const seed = new NodeSqlite.DatabaseSync(empty);
          seed.exec("CREATE TABLE unrelated (a)");
          seed.close();
        });
        const db = yield* openImessageChatDb(empty);
        assert.equal((yield* Effect.flip(db.maxRowId)).category, "database_unavailable");
        assert.equal((yield* Effect.flip(db.rowsAfter(0, 1))).category, "database_unavailable");
        assert.equal((yield* Effect.flip(db.rowById(1))).category, "database_unavailable");
        yield* db.close;
        const junk = NodePath.join(dir, "junk.sqlite");
        yield* Effect.sync(() => NodeFS.writeFileSync(junk, "this is not a database"));
        const broken = yield* openImessageChatDb(junk);
        assert.equal((yield* Effect.flip(broken.maxRowId)).category, "database_unavailable");
        yield* broken.close;
      }),
    ),
  );
});
