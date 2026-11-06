import {
  ASSISTANT_TEAM_ACTIVITY_LIMIT,
  ASSISTANT_TEAM_MESSAGE_MAX_CHARS,
  type AssistantId,
  type AssistantTeam,
  type AssistantTeamId,
  type AssistantTeamMessage,
  assistantIdFromThreadId,
  ASSISTANT_THREAD_PREFIX,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Teammates may message each other in any direction, so the org chart's "never upward" argument
 * no longer rules out two assistants answering each other forever. One sender may therefore send
 * this many messages to its teammates per rolling hour; the next is refused and tells it to report
 * to the user instead.
 */
export const TEAM_SENDS_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

export interface AssistantTeamRow {
  readonly team_id: string;
  readonly name: string;
  readonly member_ids_json: string;
  readonly leader_id: string | null;
  readonly leader_title: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const MemberIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeMemberIds = Schema.decodeOption(MemberIdsJson);
export const encodeMemberIds = Schema.encodeSync(MemberIdsJson);

// A row that no longer decodes has no members rather than hiding every team.
export const toAssistantTeam = (row: AssistantTeamRow): AssistantTeam => ({
  id: row.team_id as AssistantTeamId,
  name: row.name,
  memberIds: Option.getOrElse(decodeMemberIds(row.member_ids_json), () => []) as AssistantId[],
  leaderId: row.leader_id as AssistantId | null,
  leaderTitle: row.leader_id === null ? null : row.leader_title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const allTeams = (sql: SqlClient.SqlClient) =>
  sql<AssistantTeamRow>`SELECT * FROM assistant_teams ORDER BY created_at ASC, team_id ASC`.pipe(
    Effect.map((rows) => rows.map(toAssistantTeam)),
  );

/** Teams both assistants belong to. */
export const sharedTeams = (
  teams: ReadonlyArray<AssistantTeam>,
  a: string,
  b: string,
): ReadonlyArray<AssistantTeam> =>
  a === b
    ? []
    : teams.filter(
        (team) => team.memberIds.includes(a as never) && team.memberIds.includes(b as never),
      );

/** Stream ids `assistant:<id>:<n>` of every generation; ";" is the character after ":". */
const streamRange = (assistantId: string) => ({
  from: `${ASSISTANT_THREAD_PREFIX}${assistantId}:`,
  to: `${ASSISTANT_THREAD_PREFIX}${assistantId};`,
});

interface SentRow {
  readonly message_id: string | null;
  readonly stream_id: string;
  readonly sender: string | null;
  readonly body: string | null;
  readonly sequence: number;
  readonly occurred_at: string;
}

/**
 * Agent-sent messages into one assistant's conversations, from other assistants, newest first.
 * A message is re-published while it streams, so each id keeps only its latest event.
 */
const sentInto = (sql: SqlClient.SqlClient, toAssistantId: string, limit: number) => {
  const { from, to } = streamRange(toAssistantId);
  return sql<SentRow>`
    SELECT json_extract(payload_json, '$.id') AS message_id, stream_id,
      json_extract(payload_json, '$.senderThreadId') AS sender,
      json_extract(payload_json, '$.text') AS body, sequence, occurred_at
    FROM orchestration_events e
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
      AND event_type = 'message.updated' AND stream_id >= ${from} AND stream_id < ${to}
      AND json_extract(payload_json, '$.senderThreadId') LIKE 'assistant:%'
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_events n
        WHERE n.application_event_version = 2 AND n.aggregate_kind = 'thread'
          AND n.stream_id = e.stream_id AND n.event_type = 'message.updated'
          AND n.sequence > e.sequence
          AND json_extract(n.payload_json, '$.id') = json_extract(e.payload_json, '$.id'))
    ORDER BY sequence DESC LIMIT ${limit}`;
};

/** Sends from `senderId` to any of `peerIds` in the last hour. */
export const countRecentTeamSends = Effect.fn("AssistantTeams.countRecentTeamSends")(function* (
  sql: SqlClient.SqlClient,
  senderId: string,
  peerIds: ReadonlyArray<string>,
  nowMs: number,
) {
  const since = DateTime.formatIso(DateTime.makeUnsafe(nowMs - HOUR_MS));
  let total = 0;
  for (const peerId of peerIds) {
    const rows = yield* sentInto(sql, peerId, TEAM_SENDS_PER_HOUR * 2);
    total += rows.filter(
      (row) => row.occurred_at > since && assistantIdFromThreadId(row.sender ?? "") === senderId,
    ).length;
  }
  return total;
});

/** Messages between members of the team, oldest first, read from the conversations themselves. */
export const readTeamActivity = Effect.fn("AssistantTeams.readActivity")(function* (
  sql: SqlClient.SqlClient,
  team: AssistantTeam,
) {
  const members = new Set<string>(team.memberIds);
  const found: Array<AssistantTeamMessage & { readonly sequence: number }> = [];
  for (const memberId of team.memberIds) {
    const rows = yield* sentInto(sql, memberId, ASSISTANT_TEAM_ACTIVITY_LIMIT);
    for (const row of rows) {
      const from = assistantIdFromThreadId(row.sender ?? "");
      if (from === null || from === memberId || !members.has(from)) continue;
      const text = row.body ?? "";
      found.push({
        messageId: row.message_id ?? `${row.stream_id}:${row.sequence}`,
        at: row.occurred_at,
        fromAssistantId: from as AssistantId,
        toAssistantId: memberId as AssistantId,
        fromThreadId: row.sender as ThreadId,
        toThreadId: row.stream_id as ThreadId,
        text: text.slice(0, ASSISTANT_TEAM_MESSAGE_MAX_CHARS),
        truncated: text.length > ASSISTANT_TEAM_MESSAGE_MAX_CHARS,
        sequence: row.sequence,
      });
    }
  }
  return found
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-ASSISTANT_TEAM_ACTIVITY_LIMIT)
    .map(({ sequence: _sequence, ...message }) => message);
});
