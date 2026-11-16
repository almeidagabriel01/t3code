import {
  ASSISTANT_GROUP_NEEDS_USER_TASK_STATUSES,
  ASSISTANT_GROUP_SELF_PAUSE_REASONS,
  ASSISTANT_GROUP_UNREAD_EXCLUDED_AUTHOR,
  ASSISTANT_GROUP_UNREAD_EXCLUDED_KINDS,
  ASSISTANT_GROUP_WORKING_TASK_STATUSES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

// Raw SQL, not bound parameters: the chat view is DDL. Every value comes from a contract literal.
const list = (values: ReadonlyArray<string>) => values.map((value) => `'${value}'`).join(", ");

/** Message `m` counts as unread: `assistantGroupCountsAsUnread`, for a request's line. */
export const countsAsUnreadSql = (m: string) =>
  `(${m}.request_id IS NOT NULL AND ${m}.author <> '${ASSISTANT_GROUP_UNREAD_EXCLUDED_AUTHOR}'
    AND ${m}.kind NOT IN (${list(ASSISTANT_GROUP_UNREAD_EXCLUDED_KINDS)})
    AND NOT EXISTS (SELECT 1 FROM assistant_group_messages u
      WHERE u.request_id = ${m}.request_id AND u.seq > ${m}.seq AND u.team_id = ${m}.team_id
        AND u.author = '${ASSISTANT_GROUP_UNREAD_EXCLUDED_AUTHOR}'))`;

/** Paused task `k` waits on the user: `assistantGroupTaskNeedsUser` for a pause. */
export const pausedTaskNeedsUserSql = (k: string) =>
  `(${k}.status = 'paused' AND ${k}.kind <> 'reply'
    AND COALESCE(${k}.reason, '') NOT IN (${list(ASSISTANT_GROUP_SELF_PAUSE_REASONS)})
    AND NOT EXISTS (SELECT 1 FROM assistant_group_tasks parent
      WHERE parent.task_id = ${k}.parent_id AND parent.status = 'paused'))`;

/** Task `k` waits on the user: `assistantGroupTaskNeedsUser`. */
const taskNeedsUserSql = (k: string) =>
  `(${pausedTaskNeedsUserSql(k)} OR (${k}.status = 'failed' AND ${k}.kind = 'root'))`;

/** The tasks of request `requestId` (an expression) need the user: `assistantGroupTasksNeedUser`. */
export const tasksNeedUserSql = (requestId: string) =>
  `(EXISTS (SELECT 1 FROM assistant_group_tasks n WHERE n.request_id = ${requestId}
      AND n.status IN (${list(ASSISTANT_GROUP_NEEDS_USER_TASK_STATUSES)}) AND ${taskNeedsUserSql("n")})
    AND NOT EXISTS (SELECT 1 FROM assistant_group_tasks w WHERE w.request_id = ${requestId}
      AND w.status IN (${list(ASSISTANT_GROUP_WORKING_TASK_STATUSES)})))`;

/**
 * Message seq `seq` of `team` lies after its newest boundary: stopped tasks count only there, as
 * the chat offers their actions there. Walks back from the newest line to the first boundary.
 */
export const afterBoundarySql = (team: string, seq: string) =>
  `${seq} > COALESCE((SELECT b.seq FROM assistant_group_messages b
    WHERE b.team_id = ${team} AND b.kind = 'boundary' ORDER BY b.seq DESC LIMIT 1), 0)`;

/**
 * The oldest request of `team`'s tab `scope` ('' for General) that waits on the user, as JSON, or
 * NULL: an open wait, tasks that need the user (after the newest boundary), or, in General, the
 * lead's question about the project before work starts. Waits and project questions stay open
 * until answered, whatever boundary follows them.
 */
// Open waits and project questions are few: their partial indexes beat walking the tab's lines.
export const scopeWaitingRequestSql = (team: string, scope: string) =>
  `(SELECT json_object('requestId', h.message_id,
      'title', COALESCE(NULLIF(h.title, ''), substr(h.text, 1, 400)),
      'reason', w.reason, 'taskReason', w.task_reason, 'assistantId', w.assistant_id)
    FROM (
      SELECT q.request_id, 'wait' AS reason, NULL AS task_reason, q.assistant_id, q.seq AS at
        FROM assistant_group_messages q
        WHERE q.team_id = ${team} AND q.wait_key IS NOT NULL AND q.wait_resolved_at IS NULL
          AND COALESCE(q.request_project_id, '') = ${scope}
      UNION ALL
      SELECT k.request_id, CASE k.status WHEN 'failed' THEN 'failed' ELSE 'paused' END,
          k.reason, k.owner_id, m.seq
        FROM assistant_group_tasks k
        JOIN assistant_group_messages m ON m.message_id = k.request_message_id
        JOIN assistant_group_messages r ON r.message_id = k.request_id
        WHERE k.team_id = ${team} AND k.status IN (${list(ASSISTANT_GROUP_NEEDS_USER_TASK_STATUSES)})
          AND r.request_project_id IS NULLIF(${scope}, '') AND ${taskNeedsUserSql("k")}
          AND ${afterBoundarySql(team, "m.seq")} AND ${tasksNeedUserSql("k.request_id")}
      UNION ALL
      SELECT a.request_id, 'project', NULL, NULL, a.seq FROM assistant_group_messages a
        WHERE ${scope} = '' AND a.team_id = ${team} AND a.request_project_id IS NULL
          AND a.asks_project = 1
          AND NOT EXISTS (SELECT 1 FROM assistant_group_tasks z WHERE z.request_id = a.request_id)
    ) w
    JOIN assistant_group_messages h ON h.message_id = w.request_id
    ORDER BY h.seq, w.at LIMIT 1)`;

/** A task counts toward the group's `working`: queued, running or waiting. */
export const workingTaskStatusesSql = list(ASSISTANT_GROUP_WORKING_TASK_STATUSES);

/**
 * Each tab ('' for General) of `team` with tasks, and how many work and how many stopped, in one
 * walk of the team's tasks. A task's tab is its request's project; one with no request, or whose
 * request is gone, is General's, so every task counts in one tab.
 */
export const taskCountsByScopeSql = (team: string) =>
  `SELECT COALESCE(h.request_project_id, '') AS scope,
      SUM(k.status IN (${workingTaskStatusesSql})) AS working,
      SUM(k.status NOT IN (${workingTaskStatusesSql})) AS stopped
    FROM assistant_group_tasks k
    LEFT JOIN assistant_group_messages h ON h.message_id = k.request_id
    WHERE k.team_id = ${team}
    GROUP BY 1`;

/** The tabs ('' for General) of `team` that have a task needing the user, for the tab list. */
export const needsUserTaskScopesSql = (team: string) =>
  `SELECT COALESCE(h.request_project_id, '') FROM assistant_group_tasks k
    JOIN assistant_group_messages h ON h.message_id = k.request_id
    WHERE k.team_id = ${team} AND k.status IN (${list(ASSISTANT_GROUP_NEEDS_USER_TASK_STATUSES)})
      AND ${taskNeedsUserSql("k")}`;

/**
 * Tab position `r` changes no count if it moves to `readSeq`: no line of its tab that counts as
 * unread lies between the two.
 */
export const cursorRedundantSql = (r: string, readSeq: string) =>
  `NOT EXISTS (SELECT 1 FROM assistant_group_messages m
    WHERE m.team_id = ${r}.team_id AND m.request_project_id IS NULLIF(${r}.scope, '')
      AND m.seq > MIN(${r}.read_seq, ${readSeq}) AND m.seq <= MAX(${r}.read_seq, ${readSeq})
      AND ${countsAsUnreadSql("m")})`;

/**
 * Raises the group's read position to just before its oldest line still unread in any tab, or to
 * its newest line, and drops the tab positions at or below it that this leaves redundant. No tab's
 * count changes; the counters then walk only the real backlog instead of everything a user who
 * reads by tab has read.
 */
export const normalizeTeamRead = Effect.fn("AssistantGroups.normalizeRead")(function* (
  sql: SqlClient.SqlClient,
  teamId: string,
) {
  const [team] = yield* sql<{ readonly read_seq: number }>`
    UPDATE assistant_teams SET read_seq = MAX(read_seq, COALESCE(
      (SELECT MIN(m.seq) - 1 FROM assistant_group_messages m
        LEFT JOIN assistant_group_read_cursors r
          ON r.team_id = m.team_id AND r.scope = COALESCE(m.request_project_id, '')
        WHERE m.team_id = ${teamId}
          AND m.seq > MIN(assistant_teams.read_seq, COALESCE((SELECT MIN(c.read_seq)
            FROM assistant_group_read_cursors c WHERE c.team_id = ${teamId}), assistant_teams.read_seq))
          AND m.seq > COALESCE(r.read_seq, assistant_teams.read_seq)
          AND ${sql.literal(countsAsUnreadSql("m"))}),
      (SELECT MAX(seq) FROM assistant_group_messages WHERE team_id = ${teamId}),
      read_seq))
    WHERE team_id = ${teamId} RETURNING read_seq`;
  if (team === undefined) return;
  yield* sql`
    DELETE FROM assistant_group_read_cursors AS r
    WHERE r.team_id = ${teamId} AND r.read_seq <= ${team.read_seq}
      AND ${sql.literal(cursorRedundantSql("r", String(team.read_seq)))}`;
});
