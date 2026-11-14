import type { AssistantId, AssistantTeam, AssistantTeamId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

export interface AssistantTeamRow {
  readonly team_id: string;
  readonly name: string;
  readonly member_ids_json: string;
  readonly lead_id: string | null;
  readonly archived_at?: string | null;
  readonly instructions?: string;
  readonly memories_json?: string;
  readonly project_ids_json?: string;
  /** Chat counters, present when the row comes from `assistant_team_state`. */
  readonly read_seq?: number;
  readonly latest_seq?: number;
  readonly unread_count?: number;
  readonly open_tasks?: number;
  readonly running_tasks?: number;
  readonly preview?: string | null;
  readonly preview_project_id?: string | null;
  readonly scopes_json?: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const MemberIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeMemberIds = Schema.decodeOption(MemberIdsJson);
export const encodeMemories = Schema.encodeSync(MemberIdsJson);
export const encodeMemberIds = Schema.encodeSync(MemberIdsJson);
const decodeScopes = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        projectId: Schema.NullOr(Schema.String),
        unreadCount: Schema.Number,
        waiting: Schema.Number,
        readSeq: Schema.Number,
      }),
    ),
  ),
);

// A row that no longer decodes has no members rather than hiding every team.
export const toAssistantTeam = (row: AssistantTeamRow): AssistantTeam => ({
  id: row.team_id as AssistantTeamId,
  name: row.name,
  memberIds: Option.getOrElse(decodeMemberIds(row.member_ids_json), () => []) as AssistantId[],
  leadId: row.lead_id as AssistantId | null,
  archivedAt: row.archived_at ?? null,
  instructions: row.instructions ?? "",
  memories: Option.getOrElse(decodeMemberIds(row.memories_json ?? "[]"), () => []),
  projectIds: Option.getOrElse(
    decodeMemberIds(row.project_ids_json ?? "[]"),
    () => [],
  ) as ProjectId[],
  ...(row.latest_seq === undefined
    ? {}
    : {
        chat: {
          latestSeq: row.latest_seq,
          readSeq: row.read_seq ?? 0,
          unreadCount: row.unread_count ?? 0,
          working: (row.open_tasks ?? 0) > 0,
          runningCount: row.running_tasks ?? 0,
          preview: row.preview ?? null,
          previewProjectId: (row.preview_project_id ?? null) as ProjectId | null,
          scopes: Option.getOrElse(decodeScopes(row.scopes_json ?? "[]"), () => []).map(
            (scope) => ({
              projectId: scope.projectId as ProjectId | null,
              unreadCount: scope.unreadCount,
              waiting: scope.waiting !== 0,
              readSeq: scope.readSeq,
            }),
          ),
        },
      }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const allTeams = (sql: SqlClient.SqlClient) =>
  sql<AssistantTeamRow>`SELECT * FROM assistant_team_state ORDER BY created_at ASC, team_id ASC`.pipe(
    Effect.map((rows) => rows.map(toAssistantTeam)),
  );
