import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
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
  // The project list of a project assistant; an existing single project becomes a list of one.
  if (!assistantColumns.some((column) => column.name === "project_ids_json")) {
    yield* sql`ALTER TABLE assistants ADD COLUMN project_ids_json TEXT`;
  }
  yield* sql`UPDATE assistants SET project_ids_json = json_array(project_id) WHERE project_ids_json IS NULL`;
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
      source TEXT NOT NULL,
      label TEXT NOT NULL,
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
  const requestColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(assistant_requests)`;
  if (!requestColumns.some((column) => column.name === "group_id")) {
    yield* sql`ALTER TABLE assistant_requests ADD COLUMN group_id TEXT`;
    yield* sql`ALTER TABLE assistant_requests ADD COLUMN reply_text TEXT`;
    yield* sql`ALTER TABLE assistant_requests ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0`;
    yield* sql`UPDATE assistant_requests SET group_id = request_id`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS assistant_requests_group_idx ON assistant_requests(group_id)`;

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

  // A group's shared chat: messages, one task per recipient, and each member's hidden thread.
  if (!teamColumns.some((column) => column.name === "archived_at")) {
    yield* sql`ALTER TABLE assistant_teams ADD COLUMN archived_at TEXT`;
  }
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
  if (!groupTaskColumns.some((column) => column.name === "expected_result")) {
    yield* sql`ALTER TABLE assistant_group_tasks ADD COLUMN expected_result TEXT`;
    yield* sql`ALTER TABLE assistant_group_tasks ADD COLUMN source_seqs_json TEXT NOT NULL DEFAULT '[]'`;
    yield* sql`ALTER TABLE assistant_group_tasks ADD COLUMN resources_json TEXT NOT NULL DEFAULT '[]'`;
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
  if (!teamColumns.some((column) => column.name === "instructions")) {
    yield* sql`ALTER TABLE assistant_teams ADD COLUMN instructions TEXT NOT NULL DEFAULT ''`;
    yield* sql`ALTER TABLE assistant_teams ADD COLUMN memories_json TEXT NOT NULL DEFAULT '[]'`;
  }
  // A team with its chat counters, so a sidebar row needs no second fetch. Recreated on every start.
  yield* sql`
    CREATE VIEW assistant_team_state AS
    SELECT t.*,
      COALESCE((SELECT MAX(seq) FROM assistant_group_messages m WHERE m.team_id = t.team_id), 0)
        AS latest_seq,
      (SELECT COUNT(*) FROM assistant_group_messages m
        WHERE m.team_id = t.team_id AND m.seq > t.read_seq AND m.author != 'user'
          AND m.kind NOT IN ('routing', 'boundary', 'change')) AS unread_count,
      (SELECT COUNT(*) FROM assistant_group_tasks k
        WHERE k.team_id = t.team_id AND k.status IN ('queued', 'running', 'waiting')) AS open_tasks,
      (SELECT substr(m.text, 1, 400) FROM assistant_group_messages m
        WHERE m.team_id = t.team_id AND m.author = 'assistant' AND m.kind = 'message'
        ORDER BY m.seq DESC LIMIT 1) AS preview
    FROM assistant_teams t
  `;
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
  if (
    scheduledColumns.length > 0 &&
    !scheduledColumns.some((column) => column.name === "missed_run_policy")
  ) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN missed_run_policy TEXT NOT NULL DEFAULT 'skip'`;
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN max_runs INTEGER`;
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
