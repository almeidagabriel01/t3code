import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ensureMemorySchema } from "./MemorySchema.ts";

// Fork-only tables live outside the numbered migrations: a fork id would collide with the next
// upstream migration, and the migrator refuses histories whose names differ (see Migrations.ts).
const FORK_MIGRATION_NAMES = ["Kanban"];

/** Drops numbered records older fork builds wrote, before the migrator checks the history. */
export const forgetForkMigrations = Effect.fn("ForkSchema.forgetForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  yield* sql`DELETE FROM effect_sql_migrations WHERE name IN ${sql.in(FORK_MIGRATION_NAMES)}`;
});

/** Creates the fork's tables when missing; safe to run on every start. */
export const ensureForkSchema = Effect.fn("ForkSchema.ensure")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_boards (
      board_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      automations_json TEXT NOT NULL,
      next_card_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_columns (
      column_id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES kanban_boards(board_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      order_key TEXT NOT NULL,
      wip_limit INTEGER,
      role TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kanban_columns_board_order_idx ON kanban_columns(board_id, order_key)`;
  // The database enforces "at most one column per role"; "none" is unlimited.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS kanban_columns_board_role_idx
    ON kanban_columns(board_id, role)
    WHERE role <> 'none'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_labels (
      label_id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES kanban_boards(board_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kanban_labels_board_idx ON kanban_labels(board_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_templates (
      template_id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES kanban_boards(board_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      color TEXT NOT NULL,
      checklist_json TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      label_ids_json TEXT NOT NULL,
      priority TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kanban_templates_board_idx ON kanban_templates(board_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      card_id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES kanban_boards(board_id) ON DELETE CASCADE,
      column_id TEXT NOT NULL REFERENCES kanban_columns(column_id),
      order_key TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT,
      priority TEXT NOT NULL,
      label_ids_json TEXT NOT NULL,
      due_at TEXT,
      estimate_json TEXT,
      checklist_json TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      archived_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (board_id, number)
    )
  `;
  // Added after the table first shipped, so older databases get it here.
  const cardColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(kanban_cards)`;
  if (!cardColumns.some((column) => column.name === "parent_card_id")) {
    yield* sql`ALTER TABLE kanban_cards ADD COLUMN parent_card_id TEXT`;
  }
  if (!cardColumns.some((column) => column.name === "attachments_json")) {
    yield* sql`ALTER TABLE kanban_cards ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`;
    yield* sql`ALTER TABLE kanban_cards ADD COLUMN cover_attachment_id TEXT`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS kanban_cards_parent_idx ON kanban_cards(parent_card_id)`;
  // Board snapshot and column neighbour lookups: live cards per column in order.
  yield* sql`
    CREATE INDEX IF NOT EXISTS kanban_cards_column_order_idx
    ON kanban_cards(column_id, order_key)
    WHERE archived_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS kanban_cards_board_archived_idx
    ON kanban_cards(board_id, archived_at DESC)
    WHERE archived_at IS NOT NULL
  `;

  // thread_id is the key: a thread links to at most one card.
  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_card_thread_links (
      thread_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES kanban_cards(card_id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kanban_card_thread_links_card_idx ON kanban_card_thread_links(card_id, linked_at)`;

  // One row per edge keeps blocks and blockedBy symmetric by construction.
  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_card_relations (
      blocker_card_id TEXT NOT NULL REFERENCES kanban_cards(card_id) ON DELETE CASCADE,
      blocked_card_id TEXT NOT NULL REFERENCES kanban_cards(card_id) ON DELETE CASCADE,
      PRIMARY KEY (blocker_card_id, blocked_card_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kanban_card_relations_blocked_idx ON kanban_card_relations(blocked_card_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_card_events (
      event_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES kanban_cards(card_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kanban_card_events_card_idx ON kanban_card_events(card_id, created_at)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_sequence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    )
  `;
  yield* sql`INSERT OR IGNORE INTO kanban_sequence (id, value) VALUES (1, 0)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_commands (
      command_id TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  // project_id is kept so delivery needs no thread lookup; the unique pair makes a retried request
  // land on the same row. delivery_error stops the sweep for a thread that is gone.
  yield* sql`
    CREATE TABLE IF NOT EXISTS decisions (
      decision_id TEXT PRIMARY KEY,
      from_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      thread_title TEXT NOT NULL,
      title TEXT NOT NULL,
      context TEXT NOT NULL,
      options_json TEXT NOT NULL,
      recommended TEXT,
      expires_at TEXT,
      status TEXT NOT NULL,
      answer_json TEXT,
      answered_at TEXT,
      delivered_at TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (from_thread_id, client_request_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS decisions_status_idx ON decisions(status, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS decisions_thread_idx ON decisions(from_thread_id, created_at)`;

  // The handle stays reserved while archived. thread_id is the current conversation; it is NULL
  // until its first launch lands. Jarvis is the one default row.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistants (
      assistant_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      tool_access TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      thread_id TEXT UNIQUE,
      generation INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS assistants_default_idx ON assistants(is_default) WHERE is_default = 1`;

  // Added after the tables first shipped, so older databases get them here.
  const decisionColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(decisions)`;
  if (!decisionColumns.some((column) => column.name === "approval_request_id")) {
    yield* sql`ALTER TABLE decisions ADD COLUMN approval_request_id TEXT`;
  }
  const assistantColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(assistants)`;
  if (!assistantColumns.some((column) => column.name === "budget_json")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN budget_json TEXT`;
  }

  // The destination's memory ceiling, captured when a person or agent saved the task.
  const scheduledColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(scheduled_tasks)`;
  if (
    scheduledColumns.length > 0 &&
    !scheduledColumns.some((column) => column.name === "memory_grant_ceiling")
  ) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN memory_grant_ceiling TEXT NOT NULL DEFAULT 'none'`;
  }

  yield* ensureMemorySchema();
});
