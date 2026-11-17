import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  backfillTeamProjects,
  forgetDeletedProjects,
} from "../assistants/AssistantTeamProjects.ts";
import {
  afterBoundarySql,
  countsAsUnreadSql,
  needsUserTaskScopesSql,
  pausedTaskNeedsUserSql,
  scopeWaitingRequestSql,
  taskCountsByScopeSql,
  workingTaskStatusesSql,
} from "../assistants/groupChatSql.ts";
import { ensureMemorySchema } from "./MemorySchema.ts";

// Fork-only tables live outside the numbered migrations: a fork id would collide with the next
// upstream migration, and the migrator refuses histories whose names differ (see Migrations.ts).
// "ThreadEventTypeIndex" was briefly numbered 77, which upstream v0.1.7 took for another migration.
const FORK_MIGRATION_NAMES = ["Kanban", "ThreadEventTypeIndex"];

/** Drops numbered records older fork builds wrote, before the migrator checks the history. */
export const forgetForkMigrations = Effect.fn("ForkSchema.forgetForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  yield* sql`DELETE FROM effect_sql_migrations WHERE name IN ${sql.in(FORK_MIGRATION_NAMES)}`;
});

/**
 * Adds each missing column on its own, so a database an older build left halfway still ends
 * complete. Returns the columns it added.
 */
const addColumns = Effect.fn("ForkSchema.addColumns")(function* (
  table: string,
  columns: ReadonlyArray<readonly [name: string, definition: string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info(${table})`;
  const added: string[] = [];
  for (const [name, definition] of columns) {
    if (existing.some((column) => column.name === name)) continue;
    yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    added.push(name);
  }
  return added;
});

/**
 * Creates the fork's tables when missing; safe to run on every start. One transaction: a start that
 * dies halfway leaves no column without its backfill.
 */
export const ensureForkSchema = Effect.fn("ForkSchema.ensure")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(ensure());
});

const ensure = Effect.fn("ForkSchema.ensureTables")(function* () {
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
  yield* addColumns("kanban_cards", [
    ["attachments_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["cover_attachment_id", "TEXT"],
    // Set on cards the problem detector filed (see problems/ProblemDetector.ts).
    ["problem_json", "TEXT"],
  ]);
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
  // Members are a JSON array of assistant ids. The optional lead is one of them.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_teams (
      team_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      member_ids_json TEXT NOT NULL,
      lead_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // Jarvis is created on first use only; this marker keeps a deleted one from coming back.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_seeds (
      assistant_id TEXT PRIMARY KEY,
      seeded_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO assistant_seeds (assistant_id, seeded_at)
    SELECT assistant_id, created_at FROM assistants WHERE is_default = 1
  `;
  // One marker per seeded model default, so a default the user cleared never comes back.
  yield* sql`
    CREATE TABLE IF NOT EXISTS model_selection_seeds (
      seed_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `;

  // Chat-app bridge. The inbox is keyed by the transport's idempotency key so a redelivery is a
  // no-op; the outbox by delivery id so a replayed event never posts twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_inbox (
      connection_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (connection_id, idempotency_key)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_outbox (
      delivery_id TEXT PRIMARY KEY,
      message_json TEXT NOT NULL,
      replaces_delivery_id TEXT,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      external_message_id TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_outbox_due_idx ON channel_outbox(state, next_attempt_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_conversations (
      connection_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      PRIMARY KEY (connection_id, conversation_key)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_reply_targets (
      assistant_id TEXT PRIMARY KEY,
      address_json TEXT NOT NULL,
      actor_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_identities (
      connection_id TEXT NOT NULL,
      external_actor_id TEXT NOT NULL,
      display_name TEXT,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, external_actor_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_link_codes (
      code_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      used_at TEXT
    )
  `;
  // iMessage polling: the ROWID cursor with the rows still waiting for their chat, what the
  // transport sent (so its echo is not read back), and self-chat messages already shown.
  yield* sql`
    CREATE TABLE IF NOT EXISTS imessage_cursor (
      id TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL,
      pending_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS imessage_sent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chat_guid TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      UNIQUE (delivery_id, chunk_index)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS imessage_seen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_guid TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      date_ms INTEGER NOT NULL
    )
  `;
  // Telegram long polling: the next update offset, and the reply pieces already sent so a
  // retried delivery does not repeat them.
  yield* sql`
    CREATE TABLE IF NOT EXISTS telegram_cursor (
      id TEXT PRIMARY KEY,
      update_offset INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS telegram_sent (
      delivery_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      PRIMARY KEY (delivery_id, chunk_index)
    )
  `;
  // A piece is confirmed once the chat app answered for it; an unconfirmed one is sent again on
  // retry. Older builds kept the claim of a piece whose send timed out, which was always the last
  // piece tried of a delivery left ambiguous: only that one is unconfirmed on upgrade.
  for (const table of ["telegram_sent", "imessage_sent"] as const) {
    if ((yield* addColumns(table, [["confirmed", "INTEGER NOT NULL DEFAULT 1"]])).length === 0) {
      continue;
    }
    yield* sql.unsafe(`
      UPDATE ${table} SET confirmed = 0
      WHERE (delivery_id, chunk_index) IN (
        SELECT delivery_id, MAX(chunk_index) FROM ${table}
        WHERE delivery_id IN (SELECT delivery_id FROM channel_outbox WHERE state = 'ambiguous')
        GROUP BY delivery_id
      )`);
  }
  // A piece sent again owes an echo per send, between its first and its last send.
  const echoColumns = yield* addColumns("imessage_sent", [
    ["echoes_due", "INTEGER NOT NULL DEFAULT 1"],
    ["first_sent_at_ms", "INTEGER"],
  ]);
  if (echoColumns.includes("echoes_due")) {
    yield* sql`UPDATE imessage_sent SET echoes_due = 0 WHERE consumed = 1`;
  }
  // Which side of a self chat stored a seen row, to tell a twin from another send's echo.
  yield* addColumns("imessage_seen", [["from_me", "INTEGER"]]);
  // Set once the outbox put a delivery that ran out of tries back in line on its own.
  yield* addColumns("channel_outbox", [["auto_requeued", "INTEGER NOT NULL DEFAULT 0"]]);
  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_cards (
      decision_id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL
    )
  `;

  // Added after the tables first shipped, so older databases get them here.
  const decisionColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(decisions)`;
  if (!decisionColumns.some((column) => column.name === "approval_request_id")) {
    yield* sql`ALTER TABLE decisions ADD COLUMN approval_request_id TEXT`;
  }
  // When a computer-use action ran for this approval, so a restart can never run it twice.
  if (!decisionColumns.some((column) => column.name === "executed_at")) {
    yield* sql`ALTER TABLE decisions ADD COLUMN executed_at TEXT`;
  }
  // kind NULL reads as "choice"; steps_json is the user's checklist for any kind.
  yield* addColumns("decisions", [
    ["kind", "TEXT"],
    ["steps_json", "TEXT"],
  ]);
  const assistantColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(assistants)`;
  if (!assistantColumns.some((column) => column.name === "budget_json")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN budget_json TEXT`;
  }
  if (!assistantColumns.some((column) => column.name === "autonomy_json")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN autonomy_json TEXT`;
  }
  if (!assistantColumns.some((column) => column.name === "role")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN role TEXT NOT NULL DEFAULT ''`;
  }
  // Groups have no leader or org chart; the old leader becomes the lead, the rest is dropped.
  if (assistantColumns.some((column) => column.name === "reports_to")) {
    yield* sql`ALTER TABLE assistants DROP COLUMN reports_to`;
  }
  // Dropped first so no table change below meets a view that reads it.
  yield* sql`DROP VIEW IF EXISTS assistant_team_state`;
  const teamColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(assistant_teams)`;
  if (teamColumns.some((column) => column.name === "leader_id")) {
    yield* sql`ALTER TABLE assistant_teams RENAME COLUMN leader_id TO lead_id`;
  }
  if (teamColumns.some((column) => column.name === "leader_title")) {
    yield* sql`ALTER TABLE assistant_teams DROP COLUMN leader_title`;
  }
  if (!assistantColumns.some((column) => column.name === "ask_before_acting")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN ask_before_acting INTEGER NOT NULL DEFAULT 0`;
  }
  if (!assistantColumns.some((column) => column.name === "workspace")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN workspace TEXT NOT NULL DEFAULT 'host'`;
  }
  // One row at most: the sandbox container this environment linked to for assistants.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_sandbox (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      environment_id TEXT NOT NULL,
      linked_at TEXT NOT NULL
    )
  `;
  // One row at most: how the sandbox is run. `chosen` stays 0 until the user picks a CPU limit.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_sandbox_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cpus INTEGER,
      chosen INTEGER NOT NULL DEFAULT 0,
      when_done TEXT NOT NULL DEFAULT 'discard',
      one_off INTEGER NOT NULL DEFAULT 0
    )
  `;
  // Tasks running in the sandbox from this environment, so the container outlives the last of them.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_sandbox_task (task_id TEXT PRIMARY KEY)
  `;
  if (!assistantColumns.some((column) => column.name === "icon")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN icon TEXT`;
  }
  if (!assistantColumns.some((column) => column.name === "avatar_json")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN avatar_json TEXT`;
  }
  if (!assistantColumns.some((column) => column.name === "scope")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN scope TEXT`;
  }
  if (!assistantColumns.some((column) => column.name === "mcp_servers_json")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN mcp_servers_json TEXT`;
  }
  // Which T3 MCP servers its sessions get; NULL reads as all of them.
  if (!assistantColumns.some((column) => column.name === "integrations_json")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN integrations_json TEXT`;
  }
  // The project list of a project assistant; an existing single project becomes a list of one.
  if (!assistantColumns.some((column) => column.name === "project_ids_json")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN project_ids_json TEXT`;
  }
  yield* sql`UPDATE assistants SET project_ids_json = json_array(project_id) WHERE project_ids_json IS NULL`;
  // Starts as the model of its current conversation, once: a default the user clears stays cleared.
  if (!assistantColumns.some((column) => column.name === "default_model_selection")) {
    const threadTables = yield* sql`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`ALTER TABLE assistants ADD COLUMN default_model_selection TEXT`;
        if (threadTables.length === 0) return;
        yield* sql`
            UPDATE assistants SET default_model_selection = (
              SELECT json_extract(t.payload_json, '$.modelSelection')
              FROM orchestration_v2_projection_threads t WHERE t.thread_id = assistants.thread_id)
            WHERE default_model_selection IS NULL AND thread_id IS NOT NULL`;
      }),
    );
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS autonomy_watches (
      watch_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      title TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      instruction TEXT NOT NULL,
      one_shot INTEGER NOT NULL,
      expires_at TEXT,
      enabled INTEGER NOT NULL,
      trigger_count INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TEXT,
      created_at TEXT NOT NULL
    )
  `;
  // One row per wake, keyed by (run or thread, rule): a replayed event finds it and does nothing.
  yield* sql`
    CREATE TABLE IF NOT EXISTS autonomy_wakes (
      wake_key TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      watched_thread_id TEXT NOT NULL,
      -- 'rule' wakes share a minimum interval per thread; 'watch' wakes are asked for and exempt.
      -- 'notify' rows are an assistant's messages to the user, counted against their own limit.
      source TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  // Problem detection (problems/ProblemDetector.ts). One row per failure occurrence, keyed by what
  // happened rather than by its delivery, so a replayed or retried event is stored once.
  yield* sql`
    CREATE TABLE IF NOT EXISTS problem_occurrences (
      event_key TEXT PRIMARY KEY,
      fingerprint TEXT,
      project_id TEXT NOT NULL,
      -- Null when the occurrence is not a problem by itself; three in a day still make one.
      kind TEXT,
      reason TEXT,
      report_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      processed_at TEXT,
      skip_reason TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS problem_occurrences_pending_idx
    ON problem_occurrences(occurred_at) WHERE processed_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS problem_occurrences_fingerprint_idx
    ON problem_occurrences(fingerprint, occurred_at)
  `;
  // One row per cause; `generation` counts its cards, so a cause that returns after its card was
  // done gets a new card.
  yield* sql`
    CREATE TABLE IF NOT EXISTS problem_causes (
      fingerprint TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      card_id TEXT NOT NULL,
      card_number INTEGER NOT NULL,
      previous_card_number INTEGER,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL,
      owner_id TEXT,
      ignored INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL,
      last_comment_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE TABLE IF NOT EXISTS problem_cards (card_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)`;
  // A card whose owner has not been woken yet; held while autonomy is paused or at its limits.
  yield* sql`
    CREATE TABLE IF NOT EXISTS problem_wakes (
      card_id TEXT PRIMARY KEY,
      owner_id TEXT,
      project_id TEXT NOT NULL,
      reassigned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;
  // One row per provider instance, account and usage window: whether its low-limit alert is armed,
  // and the episode it last sent, so a restart or a repeated reading never tells the user twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_limit_alert_state (
      instance_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      window_id TEXT NOT NULL,
      resets_at TEXT,
      armed INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      fired_threshold INTEGER,
      fired_key TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, account_key, window_id)
    )
  `;
  // One row per thing that waited on the user and was told about: a request, a decision or a
  // paused group task. It is what keeps each from being told twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS autonomy_needs_you (
      subject_key TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  // One row per assistant request that expects a reply, keyed by its message id.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_requests (
      request_id TEXT PRIMARY KEY,
      sender_thread_id TEXT NOT NULL,
      recipient_thread_id TEXT NOT NULL,
      -- 'open' until the recipient replies, or its run fails and the asker is told it is blocked.
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  // A request sent to several assistants shares a group; its replies are held in the rows until the
  // group is complete, then delivered to the asker as one message.
  yield* addColumns("assistant_requests", [
    ["group_id", "TEXT"],
    ["reply_text", "TEXT"],
    ["delivered", "INTEGER NOT NULL DEFAULT 0"],
  ]);
  // Runs on every start: an older build could add the column and stop before filling it.
  yield* sql`UPDATE assistant_requests SET group_id = request_id WHERE group_id IS NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_requests_group_idx ON assistant_requests(group_id)`;

  // What the last task event told a conversation about a thread (TaskEventNotices): a run that
  // changes nothing against it wakes no one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_task_notices (
      thread_id TEXT NOT NULL,
      subject_thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      head_sha TEXT,
      message_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, subject_thread_id)
    )
  `;

  // A thread an assistant launched for real work; its state is the thread's own.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_tasks (
      thread_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_tasks_assistant_idx ON assistant_tasks(assistant_id)`;
  const assistantTaskColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(assistant_tasks)`;
  if (!assistantTaskColumns.some((column) => column.name === "dismissed_at")) {
    yield* sql`ALTER TABLE assistant_tasks ADD COLUMN dismissed_at TEXT`;
  }
  // The run whose delivered result dismissed the task: a Restore is never undone for that run.
  if (!assistantTaskColumns.some((column) => column.name === "auto_dismissed_run_id")) {
    yield* sql`ALTER TABLE assistant_tasks ADD COLUMN auto_dismissed_run_id TEXT`;
  }
  if (!assistantTaskColumns.some((column) => column.name === "source_thread_id")) {
    yield* sql`ALTER TABLE assistant_tasks ADD COLUMN source_thread_id TEXT`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_tasks_source_idx ON assistant_tasks(source_thread_id)`;

  // A group's shared chat: messages, one task per recipient, and each member's hidden thread.
  if (!teamColumns.some((column) => column.name === "archived_at")) {
    yield* sql`ALTER TABLE assistant_teams ADD COLUMN archived_at TEXT`;
  }
  // Projects a group gives its members, on top of their own.
  // The column is the "backfilled" marker, so it must not outlive a failed backfill.
  if (!teamColumns.some((column) => column.name === "project_ids_json")) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`ALTER TABLE assistant_teams ADD COLUMN project_ids_json TEXT NOT NULL DEFAULT '[]'`;
        yield* backfillTeamProjects(sql);
      }),
    );
  }
  yield* forgetDeletedProjects(sql);
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_group_messages (
      message_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      author TEXT NOT NULL,
      assistant_id TEXT,
      author_label TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to TEXT,
      task_id TEXT,
      client_request_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (team_id, seq),
      UNIQUE (team_id, client_request_id)
    )
  `;
  const groupMessageColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(assistant_group_messages)`;
  if (!groupMessageColumns.some((column) => column.name === "attachments_json")) {
    yield* sql`ALTER TABLE assistant_group_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_group_tasks (
      task_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      parent_id TEXT,
      kind TEXT NOT NULL,
      request_message_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      result_text TEXT,
      hops INTEGER NOT NULL DEFAULT 0,
      followup TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  const groupTaskColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(assistant_group_tasks)`;
  yield* addColumns("assistant_group_tasks", [
    ["expected_result", "TEXT"],
    ["source_seqs_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["resources_json", "TEXT NOT NULL DEFAULT '[]'"],
  ]);
  // Hand-offs since a task last delivered. Additive with a default, so an older build still runs.
  if (!groupTaskColumns.some((column) => column.name === "undelivered_hops")) {
    yield* sql`ALTER TABLE assistant_group_tasks ADD COLUMN undelivered_hops INTEGER NOT NULL DEFAULT 0`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_tasks_team_idx ON assistant_group_tasks(team_id, status)`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_tasks_root_idx ON assistant_group_tasks(root_id)`;
  // How far the user has read each group's chat. Groups that already have messages start read.
  if (!teamColumns.some((column) => column.name === "read_seq")) {
    yield* sql`ALTER TABLE assistant_teams ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0`;
    yield* sql`
      UPDATE assistant_teams SET read_seq = COALESCE(
        (SELECT MAX(seq) FROM assistant_group_messages m WHERE m.team_id = assistant_teams.team_id), 0)`;
  }
  // default_model_selection: the model a group request starts on, below the project's own default.
  yield* addColumns("assistant_teams", [
    ["instructions", "TEXT NOT NULL DEFAULT ''"],
    ["memories_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["default_model_selection", "TEXT"],
    // NULL reads as "requests".
    ["conversation_mode", "TEXT"],
  ]);
  // A member's hidden thread for a group, and the last chat message that thread was shown.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_group_threads (
      team_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      seen_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (team_id, assistant_id)
    )
  `;

  // Requests: a message replying to nothing starts one (request_id = its own id) and everything
  // said or done for it carries that id. The first message holds the project and short title.
  yield* addColumns("assistant_group_messages", [
    ["request_id", "TEXT"],
    ["project_id", "TEXT"],
    ["title", "TEXT"],
  ]);
  yield* addColumns("assistant_group_tasks", [["request_id", "TEXT"]]);
  // Decision outcomes that reached a task while it ran, consumed when its run ends, the answer
  // files its next turn carries, and the open decisions it inherited in a hand-over.
  yield* addColumns("assistant_group_tasks", [
    ["pending_followup_json", "TEXT"],
    ["followup_attachments_json", "TEXT"],
    ["inherited_decisions_json", "TEXT"],
  ]);
  // Every line of a request carries the request's project (NULL: General or chat-wide), so a tab
  // pages its own lines. Filled once below, in the start that adds the column; after that only
  // the rows the repair gives a request take its project, so General is never swept again.
  const scoped = yield* addColumns("assistant_group_messages", [["request_project_id", "TEXT"]]);
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_tasks_request_message_idx ON assistant_group_tasks(request_message_id)`;
  // Every start, only rows still without a request (an older build could add the columns and stop
  // before filling them): a message that opened root tasks, or a person's message replying to
  // nothing, was a request; a reply joins the request of what it answers, however deep the chain.
  yield* sql`
    UPDATE assistant_group_tasks SET request_id = (
      SELECT r.request_message_id FROM assistant_group_tasks r
      WHERE r.task_id = assistant_group_tasks.root_id)
    WHERE request_id IS NULL`;
  yield* sql`
    UPDATE assistant_group_messages SET request_id = message_id, request_project_id = project_id
    WHERE request_id IS NULL AND (
      EXISTS (SELECT 1 FROM assistant_group_tasks t
        WHERE t.kind = 'root' AND t.request_message_id = assistant_group_messages.message_id)
      OR (kind = 'message' AND author <> 'assistant' AND reply_to IS NULL))`;
  const taskRequest = sql`COALESCE(
    (SELECT t.request_id FROM assistant_group_tasks t
      WHERE t.task_id = assistant_group_messages.task_id),
    (SELECT t.request_id FROM assistant_group_tasks t
      WHERE t.kind = 'reply' AND t.request_message_id = assistant_group_messages.message_id))`;
  yield* sql`
    UPDATE assistant_group_messages SET request_id = ${taskRequest},
      request_project_id = (SELECT h.project_id FROM assistant_group_messages h
        WHERE h.message_id = ${taskRequest})
    WHERE request_id IS NULL AND (kind = 'message' OR task_id IS NOT NULL)`;
  yield* sql`
    WITH RECURSIVE chain(message_id, request_id) AS (
      SELECT message_id, request_id FROM assistant_group_messages
      WHERE request_id IS NOT NULL AND message_id IN (
        SELECT reply_to FROM assistant_group_messages WHERE request_id IS NULL)
      UNION
      SELECT m.message_id, c.request_id FROM assistant_group_messages m
      JOIN chain c ON m.reply_to = c.message_id
      WHERE m.request_id IS NULL
    )
    UPDATE assistant_group_messages SET request_id = (
      SELECT c.request_id FROM chain c WHERE c.message_id = assistant_group_messages.message_id),
      request_project_id = (SELECT h.project_id FROM chain c
        JOIN assistant_group_messages h ON h.message_id = c.request_id
        WHERE c.message_id = assistant_group_messages.message_id)
    WHERE request_id IS NULL AND reply_to IS NOT NULL`;
  // A person's reply to a message that is gone, or that belongs to no request, starts its own.
  yield* sql`
    UPDATE assistant_group_messages SET request_id = message_id, request_project_id = project_id
    WHERE request_id IS NULL AND kind = 'message' AND author <> 'assistant'`;
  // A notice that a member's conversation waits on the user: one per wait (`wait_key`), resolved in
  // place once nothing waits any more.
  yield* addColumns("assistant_group_messages", [
    ["wait_key", "TEXT"],
    ["wait_thread_id", "TEXT"],
    ["wait_decision_id", "TEXT"],
    ["wait_resolved_at", "TEXT"],
  ]);
  // The lead's notice asking which project a request is for.
  yield* addColumns("assistant_group_messages", [["asks_project", "INTEGER NOT NULL DEFAULT 0"]]);
  // A member's answer: how long its run worked.
  yield* addColumns("assistant_group_messages", [["worked_ms", "INTEGER"]]);
  // The model a user message's work starts on, picked for that message only.
  yield* addColumns("assistant_group_messages", [["model_selection", "TEXT"]]);
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS assistant_group_messages_wait_idx ON assistant_group_messages(wait_key) WHERE wait_key IS NOT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_messages_request_idx ON assistant_group_messages(request_id, seq)`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_tasks_request_idx ON assistant_group_tasks(request_id)`;
  if (scoped.length > 0)
    yield* sql`
    UPDATE assistant_group_messages SET request_project_id = (
      SELECT h.project_id FROM assistant_group_messages h
      WHERE h.message_id = assistant_group_messages.request_id)
    WHERE request_project_id IS NULL AND request_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM assistant_group_messages h
      WHERE h.message_id = assistant_group_messages.request_id AND h.project_id IS NOT NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_messages_scope_idx ON assistant_group_messages(team_id, request_project_id, seq)`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_messages_open_wait_idx ON assistant_group_messages(team_id) WHERE wait_key IS NOT NULL AND wait_resolved_at IS NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_messages_asks_project_idx ON assistant_group_messages(team_id, request_project_id) WHERE asks_project = 1`;
  // The newest boundary, which every stopped-task count reads, without walking the chat back to it.
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_messages_boundary_idx ON assistant_group_messages(team_id, seq) WHERE kind = 'boundary'`;
  // How far the user has read one tab of a group: scope is the project id, or '' for General.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_group_read_cursors (
      team_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      read_seq INTEGER NOT NULL,
      PRIMARY KEY (team_id, scope)
    )
  `;
  // A member's hidden thread for one request, in the request's project. The per-group threads above
  // stay for history and for runs that started before requests had their own.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_group_request_threads (
      request_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      seen_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (request_id, assistant_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_group_request_threads_team_idx ON assistant_group_request_threads(team_id, assistant_id)`;
  // The model the project gave the thread, and one it moves to once its turn ends.
  yield* addColumns("assistant_group_request_threads", [
    ["followed_model_selection", "TEXT"],
    ["pending_model_selection", "TEXT"],
  ]);
  // A model picked in the thread that a message's own model set aside until its task is done.
  yield* addColumns("assistant_group_request_threads", [["restore_model_selection", "TEXT"]]);
  // The message's model that switch applied: a thread off it was changed by the user since.
  yield* addColumns("assistant_group_request_threads", [["aimed_model_selection", "TEXT"]]);
  // When a delivered request left this conversation active because its work still ran.
  yield* addColumns("assistant_group_request_threads", [["settle_held_at", "TEXT"]]);
  // A team with its chat counters, recreated on every start after every column it reads. A tab
  // reads from its own cursor, else the group's read_seq; it is listed while it has unread, a wait
  // on the user, its own cursor, working or stopped tasks (so an end reads apart from a move), and
  // General while it has a request, which `general` tells clients.
  yield* sql`
    CREATE VIEW assistant_team_state AS
    SELECT s.*,
      (SELECT COALESCE(SUM(j.value ->> '$.unreadCount'), 0) FROM json_each(s.scopes_json) j)
        AS unread_count
    FROM (
      SELECT t.*,
        COALESCE((SELECT MAX(seq) FROM assistant_group_messages m WHERE m.team_id = t.team_id), 0)
          AS latest_seq,
        (SELECT COUNT(*) FROM assistant_group_tasks k
          WHERE k.team_id = t.team_id AND k.status IN (${sql.literal(workingTaskStatusesSql)}))
          AS open_tasks,
        (SELECT COUNT(*) FROM assistant_group_tasks k
          WHERE k.team_id = t.team_id AND k.status = 'running') AS running_tasks,
        (SELECT substr(m.text, 1, 400) FROM assistant_group_messages m
          WHERE m.team_id = t.team_id AND m.author = 'assistant' AND m.kind = 'message'
          ORDER BY m.seq DESC LIMIT 1) AS preview,
        (SELECT m.request_project_id FROM assistant_group_messages m
          WHERE m.team_id = t.team_id AND m.author = 'assistant' AND m.kind = 'message'
          ORDER BY m.seq DESC LIMIT 1) AS preview_project_id,
        (SELECT COUNT(DISTINCT k.root_id) FROM assistant_group_tasks k
          JOIN assistant_group_messages m ON m.message_id = k.request_message_id
          WHERE k.team_id = t.team_id AND k.status = 'paused'
            AND ${sql.literal(pausedTaskNeedsUserSql("k"))}
            AND ${sql.literal(afterBoundarySql("t.team_id", "m.seq"))}) AS paused_tasks,
        (SELECT COUNT(*) FROM assistant_group_tasks k
          JOIN assistant_group_messages m ON m.message_id = k.request_message_id
          WHERE k.team_id = t.team_id AND k.kind = 'root' AND k.status = 'failed'
            AND ${sql.literal(afterBoundarySql("t.team_id", "m.seq"))}) AS failed_tasks,
        (SELECT json_group_array(g.thread_id) FROM (
            SELECT thread_id FROM assistant_group_threads WHERE team_id = t.team_id
            UNION ALL SELECT thread_id FROM assistant_group_request_threads
              WHERE team_id = t.team_id) g) AS thread_ids_json,
        -- Each distinct request project is one scope_idx seek, not a walk of the chat.
        (WITH RECURSIVE r(id) AS (
            SELECT (SELECT MIN(m.request_project_id) FROM assistant_group_messages m
              WHERE m.team_id = t.team_id AND m.request_project_id IS NOT NULL)
            UNION ALL SELECT (SELECT MIN(m.request_project_id) FROM assistant_group_messages m
              WHERE m.team_id = t.team_id AND m.request_project_id > r.id)
            FROM r WHERE r.id IS NOT NULL)
          SELECT json_group_array(g.id) FROM (SELECT r.id FROM r WHERE r.id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM projection_projects p
              WHERE p.project_id = r.id AND p.deleted_at IS NULL)
            ORDER BY r.id) g) AS removed_project_ids_json,
        (SELECT json_group_array(json_object('projectId', NULLIF(x.scope, ''),
            'unreadCount', x.unread, 'waiting', x.waiting_request IS NOT NULL,
            'waitingRequest', json(x.waiting_request), 'readSeq', x.read_seq,
            'openTasks', x.open_tasks, 'doneTasks', x.done_tasks, 'general', x.general,
            'title', (SELECT p.title FROM projection_projects p WHERE p.project_id = x.scope)))
          FROM (
            SELECT c.scope, COALESCE(r.read_seq, t.read_seq) AS read_seq, r.read_seq AS own,
              (SELECT COUNT(*) FROM assistant_group_messages m
                WHERE m.team_id = t.team_id AND m.request_project_id IS NULLIF(c.scope, '')
                  AND m.seq > COALESCE(r.read_seq, t.read_seq) AND ${sql.literal(countsAsUnreadSql("m"))})
                AS unread,
              ${sql.literal(scopeWaitingRequestSql("t.team_id", "c.scope"))} AS waiting_request,
              c.working AS open_tasks,
              c.stopped AS done_tasks,
              (c.scope = '' AND EXISTS (SELECT 1 FROM assistant_group_messages m
                WHERE m.team_id = t.team_id AND m.request_project_id IS NULL
                  AND m.request_id IS NOT NULL)) AS general
            -- The task counts are one grouped walk of the team's tasks, added to every other tab.
            FROM (SELECT o.scope, SUM(o.working) AS working, SUM(o.stopped) AS stopped
              FROM (SELECT scope, 0 AS working, 0 AS stopped FROM (
              SELECT scope FROM assistant_group_read_cursors WHERE team_id = t.team_id
              UNION SELECT COALESCE(m.request_project_id, '') FROM assistant_group_messages m
                WHERE m.team_id = t.team_id AND m.seq > t.read_seq AND m.request_id IS NOT NULL
              UNION SELECT COALESCE(m.request_project_id, '') FROM assistant_group_messages m
                WHERE m.team_id = t.team_id AND m.wait_key IS NOT NULL
                  AND m.wait_resolved_at IS NULL
              UNION ${sql.literal(needsUserTaskScopesSql("t.team_id"))}
              UNION SELECT ''
              )
              UNION ALL ${sql.literal(taskCountsByScopeSql("t.team_id"))}) o
              GROUP BY o.scope
            ) c
            LEFT JOIN assistant_group_read_cursors r ON r.team_id = t.team_id AND r.scope = c.scope
            -- A stable order, so a client's "Removed project 2" stays the same project.
            ORDER BY c.scope
          ) x
          WHERE x.unread > 0 OR x.waiting_request IS NOT NULL OR x.own IS NOT NULL OR x.general OR x.open_tasks > 0
            OR x.done_tasks > 0)
          AS scopes_json
      FROM assistant_teams t
    ) s
  `;
  // A member's request conversation a cleared chat left it, deleted with the member.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_kept_threads (
      thread_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL
    )
  `;

  // A group's rolling chat summary, and the last message number it covers.
  yield* sql`
    CREATE TABLE IF NOT EXISTS assistant_group_summaries (
      team_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      through_seq INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

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
  if (
    scheduledColumns.length > 0 &&
    !scheduledColumns.some((column) => column.name === "assistant_team_id")
  ) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN assistant_team_id TEXT`;
  }
  if (scheduledColumns.length > 0) {
    yield* addColumns("scheduled_tasks", [
      ["missed_run_policy", "TEXT NOT NULL DEFAULT 'skip'"],
      ["max_runs", "INTEGER"],
    ]);
  }
  if (
    scheduledColumns.length > 0 &&
    !scheduledColumns.some((column) => column.name === "owner_assistant_id")
  ) {
    yield* sql.withTransaction(sql`ALTER TABLE scheduled_tasks ADD COLUMN owner_assistant_id TEXT`);
  }
  // Rows saved before it keep the model they were scheduled with.
  if (
    scheduledColumns.length > 0 &&
    !scheduledColumns.some((column) => column.name === "model_follows_project")
  ) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN model_follows_project INTEGER NOT NULL DEFAULT 0`;
  }

  // The memory continuation scan asks for a thread's newest `run.updated`, first `message.updated`
  // and whether it is a subagent. Without these each lookup walked every event of the thread.
  const eventTables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_events'
  `;
  if (eventTables.length > 0) {
    yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_events_v2_thread_type_sequence_idx
    ON orchestration_events(stream_id, event_type, sequence)
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
  `;
    // Its JSON expression rejected any write of an unreadable payload; upstream's
    // created_threads index already finds a thread's one `thread.created` row.
    yield* sql`DROP INDEX IF EXISTS orchestration_events_v2_created_lineage_idx`;
  }

  yield* ensureMemorySchema();
});
