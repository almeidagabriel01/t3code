import {
  type Assistant,
  type AssistantId,
  AssistantAvatar,
  AssistantMcpServer,
  type AssistantTeam,
  type AssistantToolAccess,
  type AssistantWorkspace,
  type EnvironmentId,
  assistantIdFromThreadId,
  isAssistantGroupThreadId,
  isAssistantThreadId,
  AssistantAutonomy,
  DEFAULT_ASSISTANT_AUTONOMY,
  ProviderBudget,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { allTeams, decodeModelSelectionJson } from "./AssistantTeams.ts";

export interface AssistantRow {
  readonly assistant_id: string;
  readonly handle: string;
  readonly name: string;
  readonly project_id: string;
  readonly instructions: string;
  readonly tool_access: string;
  readonly is_default: number;
  readonly thread_id: string | null;
  readonly generation: number;
  readonly archived_at: string | null;
  readonly budget_json: string | null;
  readonly autonomy_json: string | null;
  readonly role: string;
  readonly ask_before_acting: number;
  readonly workspace: string;
  readonly icon: string | null;
  readonly avatar_json: string | null;
  /** "project" when it lives in a real project; null until the service has worked it out. */
  readonly scope: string | null;
  readonly mcp_servers_json: string | null;
  /** JSON array of the project ids a project assistant may work in; null reads as just `project_id`. */
  readonly project_ids_json?: string | null;
  readonly default_model_selection?: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const BudgetJson = Schema.fromJsonString(ProviderBudget);
// A row that no longer decodes loses its cap rather than hiding every assistant.
const decodeBudgetOption = Schema.decodeOption(BudgetJson);
const decodeBudget = (json: string) => Option.getOrNull(decodeBudgetOption(json));
export const encodeBudget = Schema.encodeSync(BudgetJson);

const AvatarJson = Schema.fromJsonString(AssistantAvatar);
// A kind written by a newer version decodes to no avatar, which shows the handle's robot.
const decodeAvatarOption = Schema.decodeOption(AvatarJson);
export const encodeAvatar = Schema.encodeSync(AvatarJson);

const AutonomyJson = Schema.fromJsonString(AssistantAutonomy);
// A row that no longer decodes falls back to "only answers", the safe default.
const decodeAutonomyOption = Schema.decodeOption(AutonomyJson);
export const encodeAutonomy = Schema.encodeSync(AutonomyJson);

/** Keeps every connector that still decodes, so one bad entry never hides the others. */
const decodeMcpServer = Schema.decodeUnknownOption(AssistantMcpServer);
const decodeMcpList = Schema.decodeOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
export const decodeMcpServers = (json: string | null): ReadonlyArray<AssistantMcpServer> =>
  json === null
    ? []
    : Option.getOrElse(decodeMcpList(json), () => []).flatMap((item) =>
        Option.toArray(decodeMcpServer(item)),
      );
export const encodeMcpServers = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(AssistantMcpServer)),
);

const ProjectIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeProjectIds = Schema.decodeOption(ProjectIdsJson);
export const encodeProjectIds = Schema.encodeSync(ProjectIdsJson);

/** The row's saved project list, or its one project; whatever its scope. */
export const savedProjectIdsOf = (row: AssistantRow): ReadonlyArray<ProjectId> => {
  const saved =
    row.project_ids_json == null
      ? []
      : Option.getOrElse(decodeProjectIds(row.project_ids_json), () => []);
  return (saved.length === 0 ? [row.project_id] : saved) as ReadonlyArray<ProjectId>;
};

/** The projects a row may work in: empty for "all", else its saved list or its one project. */
const projectIdsOf = (row: AssistantRow): ReadonlyArray<ProjectId> =>
  row.scope === "project" ? savedProjectIdsOf(row) : [];

export const toAssistant = (row: AssistantRow): Assistant => ({
  id: row.assistant_id as AssistantId,
  handle: row.handle,
  name: row.name,
  projectId: row.project_id as ProjectId,
  projectIds: projectIdsOf(row),
  instructions: row.instructions,
  toolAccess: row.tool_access as AssistantToolAccess,
  isDefault: row.is_default === 1,
  threadId: row.thread_id as ThreadId | null,
  generation: row.generation,
  archivedAt: row.archived_at,
  role: row.role,
  askBeforeActing: row.ask_before_acting === 1,
  workspace: (row.workspace === "sandbox" ? "sandbox" : "host") satisfies AssistantWorkspace,
  icon: row.icon,
  avatar: row.avatar_json === null ? null : Option.getOrNull(decodeAvatarOption(row.avatar_json)),
  scope: row.scope === "project" ? "project" : "all",
  mcpServers: decodeMcpServers(row.mcp_servers_json),
  budget: row.budget_json === null ? null : decodeBudget(row.budget_json),
  autonomy:
    row.autonomy_json === null
      ? DEFAULT_ASSISTANT_AUTONOMY
      : Option.getOrElse(decodeAutonomyOption(row.autonomy_json), () => DEFAULT_ASSISTANT_AUTONOMY),
  defaultModelSelection: decodeModelSelectionJson(row.default_model_selection),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface AssistantDirectoryShape {
  /** The teams the assistant is in, with its active teammates; archived ones left out. */
  readonly teamsOf: (assistant: Assistant) => Effect.Effect<
    ReadonlyArray<{
      readonly team: AssistantTeam;
      readonly lead: Assistant | null;
      readonly teammates: ReadonlyArray<Assistant>;
    }>
  >;
  /** The linked environment of the sandbox container; none until it has been linked. */
  readonly sandboxEnvironmentId: Effect.Effect<Option.Option<EnvironmentId>>;
  /** None without a query unless `threadId` is an assistant thread id. */
  readonly forThread: (threadId: ThreadId) => Effect.Effect<
    Option.Option<{
      readonly assistant: Assistant;
      readonly current: boolean;
      /** For a member's group conversation: its group, or null once no active group holds it. */
      readonly team?: AssistantTeam | null;
    }>
  >;
  /** The assistant that launched this thread as a task. Task threads are ordinary threads. */
  readonly taskOwner: (threadId: ThreadId) => Effect.Effect<Option.Option<Assistant>>;
  /** Whether a group still owns this hidden thread; absent means it does. */
  readonly inGroup?: (threadId: ThreadId) => Effect.Effect<boolean>;
  /** Titles of the projects that still exist; a missing or unreadable one is simply absent. */
  readonly projectTitles?: (
    projectIds: ReadonlyArray<string>,
  ) => Effect.Effect<Readonly<Record<string, string>>>;
}

export class AssistantDirectory extends Context.Service<
  AssistantDirectory,
  AssistantDirectoryShape
>()("t3/assistants/AssistantDirectory") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const live =
    sql<AssistantRow>`SELECT * FROM assistants WHERE archived_at IS NULL ORDER BY created_at ASC`.pipe(
      Effect.orDie,
    );
  const directory: AssistantDirectoryShape = {
    teamsOf: Effect.fn("AssistantDirectory.teamsOf")(function* (assistant) {
      const all = (yield* live).map(toAssistant);
      return (yield* allTeams(sql))
        .filter((team) => team.archivedAt === null && team.memberIds.includes(assistant.id))
        .map((team) => ({
          team,
          lead: all.find((other) => other.id === team.leadId) ?? null,
          teammates: all.filter(
            (other) => other.id !== assistant.id && team.memberIds.includes(other.id),
          ),
        }));
    }, Effect.orDie),
    sandboxEnvironmentId: sql<{ readonly environment_id: string }>`
      SELECT environment_id FROM assistant_sandbox WHERE singleton = 1`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.environment_id as EnvironmentId)),
      // A failed read must not look like "not linked": the refusal would then send the work nowhere.
      Effect.orDie,
    ),
    projectTitles: (projectIds) =>
      projectIds.length === 0
        ? Effect.succeed({})
        : sql<{ readonly project_id: string; readonly title: string }>`
            SELECT project_id, title FROM projection_projects
            WHERE project_id IN ${sql.in(projectIds)} AND deleted_at IS NULL`.pipe(
            Effect.map((rows) =>
              Object.fromEntries(rows.map((row) => [row.project_id, row.title])),
            ),
            Effect.orElseSucceed(() => ({})),
          ),
    taskOwner: Effect.fn("AssistantDirectory.taskOwner")(function* (threadId) {
      if (isAssistantThreadId(threadId)) return Option.none();
      const rows = yield* sql<AssistantRow>`
        SELECT a.* FROM assistant_tasks t JOIN assistants a ON a.assistant_id = t.assistant_id
        WHERE t.thread_id = ${threadId}`;
      return Option.fromNullishOr(rows[0]).pipe(Option.map(toAssistant));
    }, Effect.orDie),
    forThread: Effect.fn("AssistantDirectory.forThread")(function* (threadId) {
      if (!isAssistantThreadId(threadId)) return Option.none();
      const current =
        yield* sql<AssistantRow>`SELECT * FROM assistants WHERE thread_id = ${threadId}`;
      if (current[0] !== undefined)
        return Option.some({ assistant: toAssistant(current[0]), current: true });
      const id = assistantIdFromThreadId(threadId);
      if (id === null) return Option.none();
      const owner = yield* sql<AssistantRow>`SELECT * FROM assistants WHERE assistant_id = ${id}`;
      if (owner[0] === undefined) return Option.none();
      const assistant = toAssistant(owner[0]);
      if (!isAssistantGroupThreadId(threadId)) return Option.some({ assistant, current: false });
      const held = yield* sql<{ readonly team_id: string }>`
        SELECT team_id FROM assistant_group_threads WHERE thread_id = ${threadId}
        UNION ALL SELECT team_id FROM assistant_group_request_threads WHERE thread_id = ${threadId}
        LIMIT 1`;
      const team = (yield* allTeams(sql)).find(
        (candidate) => candidate.id === held[0]?.team_id && candidate.archivedAt === null,
      );
      return Option.some({ assistant, current: false, team: team ?? null });
      // A failed read must not look like "not an assistant": that would drop its read-only limit.
    }, Effect.orDie),
    inGroup: Effect.fn("AssistantDirectory.inGroup")(
      function* (threadId) {
        const rows = yield* sql`
        SELECT 1 FROM assistant_group_threads WHERE thread_id = ${threadId}
        UNION ALL SELECT 1 FROM assistant_group_request_threads WHERE thread_id = ${threadId}
        LIMIT 1`;
        return rows.length > 0;
        // A failed read keeps the thread the group's: the guard then refuses instead of letting it go.
      },
      Effect.orElseSucceed(() => true),
    ),
  };
  return AssistantDirectory.of(directory);
});

export const layer = Layer.effect(AssistantDirectory, make);
