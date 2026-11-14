import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { assistantGroupProjectIds, type ProjectId } from "@t3tools/contracts";

import { type AssistantRow, savedProjectIdsOf, toAssistant } from "./AssistantDirectory.ts";
import { encodeMemberIds } from "./AssistantTeams.ts";

const decodeIds = Schema.decodeOption(Schema.fromJsonString(Schema.Array(Schema.String)));

/**
 * Gives each group the projects all its members already list, so the first group lists change no
 * one's access. Only a member that reaches every project is left out; deleted projects are dropped.
 */
export const backfillTeamProjects = Effect.fn("AssistantTeams.backfillProjects")(function* (
  sql: SqlClient.SqlClient,
) {
  const teams = yield* sql<{ readonly team_id: string; readonly member_ids_json: string }>`
    SELECT team_id, member_ids_json FROM assistant_teams`;
  const members = yield* sql<AssistantRow>`SELECT * FROM assistants`;
  const hasProjects =
    (yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_projects'`)
      .length > 0;
  const live = hasProjects
    ? new Set(
        (yield* sql<{ readonly project_id: string }>`
          SELECT project_id FROM projection_projects WHERE deleted_at IS NULL`).map(
          (row) => row.project_id,
        ),
      )
    : null;
  for (const team of teams) {
    const ids = Option.getOrElse(decodeIds(team.member_ids_json), () => []);
    const lists = ids.flatMap((id) => {
      const row = members.find((member) => member.assistant_id === id);
      return row === undefined || row.scope === "all" ? [] : [savedProjectIdsOf(row)];
    });
    const [first, ...rest] = lists;
    const shared = (first ?? []).filter(
      (id) => rest.every((list) => list.includes(id)) && (live === null || live.has(id)),
    );
    if (shared.length === 0) continue;
    yield* sql`UPDATE assistant_teams SET project_ids_json = ${encodeMemberIds(shared)}
      WHERE team_id = ${team.team_id}`;
  }
});

/** Takes deleted projects off every assistant's and group's list; unreadable lists stay as they are. */
export const forgetDeletedProjects = Effect.fn("AssistantTeams.forgetDeletedProjects")(function* (
  sql: SqlClient.SqlClient,
) {
  const hasProjects =
    (yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_projects'`)
      .length > 0;
  const changed = { assistantIds: [] as Array<string>, teamIds: [] as Array<string> };
  if (!hasProjects) return changed;
  const deleted = new Set(
    (yield* sql<{ readonly project_id: string }>`
      SELECT project_id FROM projection_projects WHERE deleted_at IS NOT NULL`).map(
      (row) => row.project_id,
    ),
  );
  if (deleted.size === 0) return changed;
  const pruned = (json: string | null) => {
    const ids = json === null ? [] : Option.getOrElse(decodeIds(json), () => []);
    const kept = ids.filter((id) => !deleted.has(id));
    return kept.length === ids.length ? null : encodeMemberIds(kept);
  };
  const assistants = yield* sql<{ readonly id: string; readonly list: string | null }>`
    SELECT assistant_id AS id, project_ids_json AS list FROM assistants`;
  for (const row of assistants) {
    const list = pruned(row.list);
    if (list === null) continue;
    yield* sql`UPDATE assistants SET project_ids_json = ${list} WHERE assistant_id = ${row.id}`;
    changed.assistantIds.push(row.id);
  }
  const teams = yield* sql<{ readonly id: string; readonly list: string }>`
    SELECT team_id AS id, project_ids_json AS list FROM assistant_teams`;
  for (const row of teams) {
    const list = pruned(row.list);
    if (list === null) continue;
    yield* sql`UPDATE assistant_teams SET project_ids_json = ${list} WHERE team_id = ${row.id}`;
    changed.teamIds.push(row.id);
  }
  return changed;
});

/**
 * Drops each group's tab positions for projects the group no longer has, and returns the groups
 * that changed. A position stays while dropping it would change what that tab counts as unread.
 */
export const pruneLeftTabCursors = Effect.fn("AssistantTeams.pruneLeftTabCursors")(function* (
  sql: SqlClient.SqlClient,
) {
  const teams = yield* sql<{
    readonly team_id: string;
    readonly member_ids_json: string;
    readonly project_ids_json: string;
  }>`
    SELECT team_id, member_ids_json, project_ids_json FROM assistant_teams t
    WHERE EXISTS (SELECT 1 FROM assistant_group_read_cursors r
      WHERE r.team_id = t.team_id AND r.scope <> '')`;
  if (teams.length === 0) return [];
  const members = yield* sql<AssistantRow>`SELECT * FROM assistants`;
  const changed: Array<string> = [];
  for (const team of teams) {
    const memberIds = Option.getOrElse(
      decodeIds(team.member_ids_json),
      (): ReadonlyArray<string> => [],
    );
    const kept = assistantGroupProjectIds(
      members.filter((row) => memberIds.includes(row.assistant_id)).map(toAssistant),
      Option.getOrElse(decodeIds(team.project_ids_json), () => []) as ReadonlyArray<ProjectId>,
    );
    const dropped = yield* sql`
      DELETE FROM assistant_group_read_cursors AS r
      WHERE r.team_id = ${team.team_id} AND r.scope <> ''
        AND r.scope NOT IN (SELECT value FROM json_each(${encodeMemberIds(kept)}))
        AND NOT EXISTS (SELECT 1 FROM assistant_group_messages m
          JOIN assistant_teams t ON t.team_id = r.team_id
          WHERE m.team_id = r.team_id AND m.request_project_id = r.scope
            AND m.seq > MIN(r.read_seq, t.read_seq) AND m.seq <= MAX(r.read_seq, t.read_seq)
            AND m.request_id IS NOT NULL AND m.author <> 'user'
            AND m.kind NOT IN ('routing', 'boundary', 'change'))
      RETURNING scope`;
    if (dropped.length > 0) changed.push(team.team_id);
  }
  return changed;
});
