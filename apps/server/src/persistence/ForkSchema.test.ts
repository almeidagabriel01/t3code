import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureForkSchema } from "./ForkSchema.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });

const columnsOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

it.effect("upgrades tables an older build created in place, keeping their rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Shapes from before subtasks, attachments and the memory ceiling existed.
    yield* sql`
      CREATE TABLE kanban_cards (
        card_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_id TEXT NOT NULL,
        order_key TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL, type TEXT, priority TEXT NOT NULL,
        label_ids_json TEXT NOT NULL, due_at TEXT, estimate_json TEXT,
        checklist_json TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL,
        archived_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE (board_id, number)
      )`;
    yield* sql`
      INSERT INTO kanban_cards VALUES ('c1','b1','col1','a',1,'Old card','', NULL,'none','[]',
        NULL,NULL,'[]','[]',NULL,'user','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    yield* sql`CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY)`;
    yield* sql`INSERT INTO scheduled_tasks VALUES ('t1')`;

    yield* ensureForkSchema();
    yield* ensureForkSchema();

    const cards = yield* columnsOf("kanban_cards");
    for (const name of ["parent_card_id", "attachments_json", "cover_attachment_id"]) {
      assert.strictEqual(cards.filter((column) => column === name).length, 1, name);
    }
    const [card] = yield* sql<{
      title: string;
      parent_card_id: string | null;
      attachments_json: string;
      cover_attachment_id: string | null;
    }>`SELECT title, parent_card_id, attachments_json, cover_attachment_id FROM kanban_cards`;
    assert.deepStrictEqual(card, {
      title: "Old card",
      parent_card_id: null,
      attachments_json: "[]",
      cover_attachment_id: null,
    });
    assert.deepStrictEqual(yield* sql`SELECT task_id, memory_grant_ceiling FROM scheduled_tasks`, [
      { task_id: "t1", memory_grant_ceiling: "none" },
    ]);
  }).pipe(Effect.provide(database)),
);

it.effect("leaves a table it does not own absent, and the database one role per column", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureForkSchema();
    assert.deepStrictEqual(yield* columnsOf("scheduled_tasks"), []);

    yield* sql`INSERT INTO kanban_boards VALUES ('b1','p1','P','{}',1,'t','t')`;
    const column = (id: string, role: string) =>
      sql`INSERT INTO kanban_columns VALUES (${id},'b1',${id},'', ${id}, NULL, ${role})`;
    yield* column("c1", "todo");
    yield* column("c2", "none");
    yield* column("c3", "none");
    const duplicate = yield* column("c4", "todo").pipe(Effect.flip);
    assert.isDefined(duplicate);
    const roles = yield* sql<{ n: number }>`SELECT count(*) AS n FROM kanban_columns`;
    assert.strictEqual(roles[0]!.n, 3);
  }).pipe(Effect.provide(database)),
);

it.effect("keeps one default assistant and one assistant per handle and thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureForkSchema();
    yield* ensureForkSchema();
    const insert = (id: string, handle: string, isDefault: number, threadId: string | null) =>
      sql`INSERT INTO assistants (assistant_id, handle, name, project_id, tool_access, is_default, thread_id, created_at, updated_at)
        VALUES (${id}, ${handle}, ${id}, 'p', 'full', ${isDefault}, ${threadId}, 't', 't')`;
    yield* insert("a", "a", 1, "assistant:a:1");
    yield* insert("b", "b", 0, null);
    yield* insert("c", "c", 0, null);
    assert.isDefined(yield* insert("d", "d", 1, null).pipe(Effect.flip));
    assert.isDefined(yield* insert("e", "a", 0, null).pipe(Effect.flip));
    assert.isDefined(yield* insert("f", "f", 0, "assistant:a:1").pipe(Effect.flip));
  }).pipe(Effect.provide(database)),
);
