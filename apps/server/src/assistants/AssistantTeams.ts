import {
  ASSISTANT_TEAM_CHAT_WAITING_TITLE_MAX_CHARS,
  type AssistantId,
  type AssistantTeam,
  type AssistantTeamId,
  AssistantTeamChatWaitingRequest,
  ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
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
  readonly default_model_selection?: string | null;
  readonly project_ids_json?: string;
  /** Chat counters, present when the row comes from `assistant_team_state`. */
  readonly read_seq?: number;
  readonly latest_seq?: number;
  readonly unread_count?: number;
  readonly open_tasks?: number;
  readonly running_tasks?: number;
  readonly running_member_ids_json?: string | null;
  readonly preview?: string | null;
  readonly paused_tasks?: number;
  readonly failed_tasks?: number;
  readonly thread_ids_json?: string | null;
  readonly preview_project_id?: string | null;
  readonly scopes_json?: string;
  readonly removed_project_ids_json?: string;
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
        title: Schema.optionalKey(Schema.NullOr(Schema.String)),
        openTasks: Schema.optionalKey(Schema.Number),
        doneTasks: Schema.optionalKey(Schema.Number),
        general: Schema.optionalKey(Schema.Number),
        waitingRequest: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              requestId: Schema.String,
              title: Schema.NullOr(Schema.String),
              text: Schema.String,
              reason: AssistantTeamChatWaitingRequest.fields.reason,
              taskReason: Schema.NullOr(Schema.String),
              assistantId: Schema.NullOr(Schema.String),
            }),
          ),
        ),
      }),
    ),
  ),
);

const clipTitle = (title: string) => {
  const chars = Array.from(title);
  const max = ASSISTANT_TEAM_CHAT_WAITING_TITLE_MAX_CHARS;
  return chars.length <= max ? title : `${chars.slice(0, max - 1).join("")}…`;
};

/** A request's title until the lead names it: its first line, without the @mentions it opens with. */
export const requestTitleFromText = (text: string) => {
  const line =
    text
      .split("\n")
      .find((candidate) => candidate.trim() !== "")
      ?.trim() ?? "";
  return clipTitle(line.replace(/^(?:@\S+[\s,]+)+/u, "") || line);
};

const ModelSelectionJson = Schema.fromJsonString(ModelSelection);
const decodeModelSelectionOption = Schema.decodeOption(ModelSelectionJson);
/** A stored default that no longer decodes reads as none, like a lost budget. */
export const decodeModelSelectionJson = (json: string | null | undefined) =>
  json == null ? null : Option.getOrNull(decodeModelSelectionOption(json));
const encodeModelSelection = Schema.encodeSync(ModelSelectionJson);
export const encodeModelSelectionJson = (selection: ModelSelection | null) =>
  selection === null ? null : encodeModelSelection(selection);

// A row that no longer decodes has no members rather than hiding every team.
export const toAssistantTeam = (row: AssistantTeamRow): AssistantTeam => ({
  id: row.team_id as AssistantTeamId,
  name: row.name,
  memberIds: Option.getOrElse(decodeMemberIds(row.member_ids_json), () => []) as AssistantId[],
  leadId: row.lead_id as AssistantId | null,
  archivedAt: row.archived_at ?? null,
  instructions: row.instructions ?? "",
  memories: Option.getOrElse(decodeMemberIds(row.memories_json ?? "[]"), () => []),
  defaultModelSelection: decodeModelSelectionJson(row.default_model_selection),
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
          runningMemberIds: Option.getOrElse(
            decodeMemberIds(row.running_member_ids_json ?? "[]"),
            () => [],
          ) as AssistantId[],
          preview: row.preview ?? null,
          pausedTasks: row.paused_tasks ?? 0,
          failedTasks: row.failed_tasks ?? 0,
          threadIds: Option.getOrElse(
            decodeMemberIds(row.thread_ids_json ?? "[]"),
            () => [],
          ) as ThreadId[],
          previewProjectId: (row.preview_project_id ?? null) as ProjectId | null,
          removedProjectIds: Option.getOrElse(
            decodeMemberIds(row.removed_project_ids_json ?? "[]"),
            () => [],
          ) as ProjectId[],
          scopes: Option.getOrElse(decodeScopes(row.scopes_json ?? "[]"), () => []).map(
            (scope) => ({
              projectId: scope.projectId as ProjectId | null,
              unreadCount: scope.unreadCount,
              waiting: scope.waiting !== 0,
              readSeq: scope.readSeq,
              ...(typeof scope.title === "string" ? { title: scope.title } : {}),
              ...(scope.openTasks === undefined || scope.openTasks === 0
                ? {}
                : { openTasks: scope.openTasks }),
              ...(scope.doneTasks === undefined || scope.doneTasks === 0
                ? {}
                : { doneTasks: scope.doneTasks }),
              ...(scope.projectId === null && scope.general !== undefined
                ? { hasRequests: scope.general !== 0 }
                : {}),
              ...(scope.waitingRequest == null
                ? {}
                : {
                    waitingRequest: {
                      requestId: scope.waitingRequest.requestId,
                      title:
                        scope.waitingRequest.title === null
                          ? requestTitleFromText(scope.waitingRequest.text)
                          : clipTitle(scope.waitingRequest.title),
                      reason: scope.waitingRequest.reason,
                      ...(scope.waitingRequest.taskReason === null
                        ? {}
                        : { taskReason: scope.waitingRequest.taskReason }),
                      assistantId: scope.waitingRequest.assistantId as AssistantId | null,
                    },
                  }),
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
