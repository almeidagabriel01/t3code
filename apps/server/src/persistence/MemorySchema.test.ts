import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ensureForkSchema } from "./ForkSchema.ts";
import { runMigrations } from "./Migrations.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });

describe("Memory schema", () => {
  it.effect("ensureForkSchema creates every memory table and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureForkSchema();
      yield* ensureForkSchema();
      const names = new Set(
        (yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE name LIKE 'memory_%'`).map((row) => row.name),
      );
      for (const name of [
        "memory_items",
        "memory_items_fts",
        "memory_events",
        "memory_payloads",
        "memory_project_bindings",
        "memory_pending_forget_intents",
        "memory_identity_ledger",
        "memory_storage_samples",
        "memory_hub_retention",
        "memory_compact_receipts",
        "memory_import_lineage",
      ])
        assert.isTrue(names.has(name), name);
      assert.isFalse(names.has("memory_report_outbox"));
      const triggers = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_%'`;
      assert.isAbove(triggers[0]!.count, 100);
      const seeds = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_quota_counters WHERE space='_hub_global'`;
      assert.strictEqual(seeds[0]!.count, 17);
    }).pipe(Effect.provide(database)),
  );
  it.effect("counts sync work discarded before the counter existed, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureForkSchema();
      // A database from before the counter: no triggers, no marker, and discards already there.
      for (const t of ["insert", "update", "delete"])
        yield* sql.unsafe(`DROP TRIGGER memory_outbox_discard_count_${t}`);
      yield* sql`DELETE FROM memory_quota_counters WHERE space='_migrations'`;
      const insert = (id: string, kind: string, code: string) =>
        sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at,failure_code) VALUES (${id},'space',${kind},'failed','{}',0,${code})`;
      yield* insert("a", "sync", "invalid_output");
      yield* insert("b", "revert_intent", "not_found");
      yield* insert("c", "sync", "source_invalidated");
      yield* insert("d", "summary", "invalid_output");
      const counted = sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='space' AND dimension='processing_discarded_sync'`;
      yield* ensureForkSchema();
      assert.deepStrictEqual(yield* counted, [{ value: 2 }]);
      // Restarts keep the live count instead of recounting.
      yield* insert("e", "sync", "unsupported_protocol");
      yield* ensureForkSchema();
      assert.deepStrictEqual(yield* counted, [{ value: 3 }]);
      yield* sql`DELETE FROM memory_outbox WHERE id='a'`;
      assert.deepStrictEqual(yield* counted, [{ value: 2 }]);
    }).pipe(Effect.provide(database)),
  );
  it.effect("QA: discard counter follows status and ignores hub rejections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureForkSchema();
      const counted = sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='space' AND dimension='processing_discarded_sync'`;
      // Rows that never were discards leave the counter alone.
      yield* sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at) VALUES ('p','space','sync','pending','{}',0)`;
      yield* sql`UPDATE memory_outbox SET status='running' WHERE id='p'`;
      assert.deepStrictEqual(yield* counted, []);
      // A database that ran the unguarded triggers keeps only the guarded ones after a restart.
      yield* sql`CREATE TRIGGER memory_outbox_discarded_sync_insert AFTER INSERT ON memory_outbox BEGIN SELECT 1; END`;
      yield* ensureForkSchema();
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_outbox_discard%' ORDER BY name`,
        ["delete", "insert", "update"].map((t) => ({ name: `memory_outbox_discard_count_${t}` })),
      );
      yield* sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at,failure_code) VALUES ('a','space','sync','failed','{}',0,'invalid_output')`;
      assert.deepStrictEqual(yield* counted, [{ value: 1 }]);
      // A rejection the hub answered carries its receipt and is counted elsewhere.
      yield* sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at,failure_code,completed_receipt_json) VALUES ('r','space','sync','failed','{}',0,'not_found','{}')`;
      assert.deepStrictEqual(yield* counted, [{ value: 1 }]);
      // Leaving failed uncounts it; coming back counts it again.
      yield* sql`UPDATE memory_outbox SET status='retry' WHERE id='a'`;
      assert.deepStrictEqual(yield* counted, [{ value: 0 }]);
      yield* sql`UPDATE memory_outbox SET status='failed' WHERE id='a'`;
      assert.deepStrictEqual(yield* counted, [{ value: 1 }]);
      // A restart with the marker present keeps the live value even when it differs from a recount.
      yield* sql`UPDATE memory_quota_counters SET value=7 WHERE space='space' AND dimension='processing_discarded_sync'`;
      yield* ensureForkSchema();
      assert.deepStrictEqual(yield* counted, [{ value: 7 }]);
    }).pipe(Effect.provide(database)),
  );
  it.effect("keeps rows across restarts and enforces constraints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureForkSchema();
      yield* sql`INSERT INTO memory_project_bindings VALUES ('space','env','project',NULL,NULL,0,0)`;
      yield* ensureForkSchema();
      assert.strictEqual((yield* sql`SELECT * FROM memory_project_bindings`).length, 1);
      const bad = yield* Effect.exit(
        sql`INSERT INTO memory_project_bindings VALUES ('space','env','project2',NULL,NULL,-1,0)`,
      );
      assert.isTrue(bad._tag === "Failure");
      const invalid = yield* Effect.exit(
        sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at) VALUES ('fixture','space','invalid','pending','{}',0)`,
      );
      assert.isTrue(invalid._tag === "Failure");
    }).pipe(Effect.provide(database)),
  );
  it.effect("keeps deletion metadata independent of thread deletion", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_tombstones (space,memory_id,delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json) VALUES ('fixture','memory','op','env',0,'[]','[]','[]')`;
      yield* sql`DELETE FROM orchestration_v2_projection_threads`;
      assert.strictEqual((yield* sql`SELECT * FROM memory_tombstones`).length, 1);
    }).pipe(Effect.provide(database)),
  );
  it.effect("source SQLite FTS removes and rebuilds eligible rows", () =>
    Effect.gen(function* () {
      yield* ensureForkSchema();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_items_fts (rowid,body) VALUES (1,'synthetic searchable')`;
      assert.strictEqual(
        (yield* sql`SELECT rowid FROM memory_items_fts WHERE memory_items_fts MATCH 'synthetic'`)
          .length,
        1,
      );
      yield* sql`DELETE FROM memory_items_fts WHERE rowid=1`;
      yield* sql`INSERT INTO memory_items_fts (memory_items_fts) VALUES ('rebuild')`;
      assert.strictEqual(
        (yield* sql`SELECT rowid FROM memory_items_fts WHERE memory_items_fts MATCH 'synthetic'`)
          .length,
        0,
      );
    }).pipe(Effect.provide(database)),
  );
});
