import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { type AssistantRow, savedProjectIdsOf } from "./AssistantDirectory.ts";
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
