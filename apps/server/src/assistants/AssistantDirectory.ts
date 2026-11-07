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

import { allTeams } from "./AssistantTeams.ts";

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

export const toAssistant = (row: AssistantRow): Assistant => ({
  id: row.assistant_id as AssistantId,
  handle: row.handle,
  name: row.name,
  projectId: row.project_id as ProjectId,
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
  readonly forThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<{ readonly assistant: Assistant; readonly current: boolean }>>;
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
        .filter((team) => team.memberIds.includes(assistant.id))
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
    forThread: Effect.fn("AssistantDirectory.forThread")(function* (threadId) {
      if (!isAssistantThreadId(threadId)) return Option.none();
      const current =
        yield* sql<AssistantRow>`SELECT * FROM assistants WHERE thread_id = ${threadId}`;
      if (current[0] !== undefined)
        return Option.some({ assistant: toAssistant(current[0]), current: true });
      const id = assistantIdFromThreadId(threadId);
      if (id === null) return Option.none();
      const owner = yield* sql<AssistantRow>`SELECT * FROM assistants WHERE assistant_id = ${id}`;
      return owner[0] === undefined
        ? Option.none()
        : Option.some({ assistant: toAssistant(owner[0]), current: false });
      // A failed read must not look like "not an assistant": that would drop its read-only limit.
    }, Effect.orDie),
  };
  return AssistantDirectory.of(directory);
});

export const layer = Layer.effect(AssistantDirectory, make);
