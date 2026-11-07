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
    // A teams table from before groups could be archived.
    yield* sql`
      CREATE TABLE assistant_teams (
        team_id TEXT PRIMARY KEY, name TEXT NOT NULL, member_ids_json TEXT NOT NULL,
        lead_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`;
    yield* sql`INSERT INTO assistant_teams VALUES ('g1', 'Core', '[]', NULL, 't', 't')`;

    yield* ensureForkSchema();
    yield* ensureForkSchema();

    assert.deepStrictEqual(yield* sql`SELECT team_id, archived_at FROM assistant_teams`, [
      { team_id: "g1", archived_at: null },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT task_id, assistant_team_id FROM scheduled_tasks`, [
      { task_id: "t1", assistant_team_id: null },
    ]);

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

it.effect("turns an old team leader into the lead and drops reports_to and leader_title", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE assistants (
        assistant_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        project_id TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', tool_access TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0, thread_id TEXT UNIQUE,
        generation INTEGER NOT NULL DEFAULT 1, archived_at TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, reports_to TEXT
      )`;
    yield* sql`
      CREATE TABLE assistant_teams (
        team_id TEXT PRIMARY KEY, name TEXT NOT NULL, member_ids_json TEXT NOT NULL,
        leader_id TEXT, leader_title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`;
    yield* sql`
      INSERT INTO assistants (assistant_id, handle, name, project_id, tool_access, created_at, updated_at, reports_to)
      VALUES ('eng', 'eng', 'Eng', 'p', 'full', 't', 't', 'ceo')`;
    yield* sql`INSERT INTO assistant_teams VALUES ('t1', 'Core', '["ceo","eng"]', 'ceo', 'CEO', 't', 't')`;

    yield* ensureForkSchema();
    yield* ensureForkSchema();

    assert.deepStrictEqual(yield* sql`SELECT team_id, lead_id FROM assistant_teams`, [
      { team_id: "t1", lead_id: "ceo" },
    ]);
    assert.isFalse((yield* columnsOf("assistant_teams")).includes("leader_title"));
    assert.isFalse((yield* columnsOf("assistants")).includes("reports_to"));
    assert.deepStrictEqual(yield* sql`SELECT assistant_id FROM assistants`, [
      { assistant_id: "eng" },
    ]);
  }).pipe(Effect.provide(database)),
);

it.effect("keeps a group's messages numbered once and a request id once per group", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureForkSchema();
    yield* ensureForkSchema();
    const message = (id: string, team: string, seq: number, request: string | null) =>
      sql`INSERT INTO assistant_group_messages
        (message_id, team_id, seq, author, kind, text, client_request_id, created_at)
        VALUES (${id}, ${team}, ${seq}, 'user', 'message', 'hi', ${request}, 't')`;
    yield* message("m1", "g1", 1, "r1");
    yield* message("m2", "g2", 1, "r1");
    yield* message("m3", "g1", 2, null);
    yield* message("m4", "g1", 3, null);
    assert.isDefined(yield* message("m5", "g1", 1, null).pipe(Effect.flip));
    assert.isDefined(yield* message("m6", "g1", 4, "r1").pipe(Effect.flip));
    yield* sql`INSERT INTO assistant_group_threads (team_id, assistant_id, thread_id) VALUES ('g1', 'a', 't1')`;
    assert.isDefined(
      yield* sql`INSERT INTO assistant_group_threads (team_id, assistant_id, thread_id)
        VALUES ('g1', 'a', 't2')`.pipe(Effect.flip),
    );
    yield* sql`INSERT INTO assistant_group_tasks
      (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status, created_at, updated_at)
      VALUES ('t', 'g1', 't', 'root', 'm1', 'a', 'do', 'queued', 't', 't')`;
    assert.deepStrictEqual(
      yield* sql`SELECT revision, hops, seen_seq FROM assistant_group_tasks, assistant_group_threads`,
      [{ revision: 1, hops: 0, seen_seq: 0 }],
    );
  }).pipe(Effect.provide(database)),
);
