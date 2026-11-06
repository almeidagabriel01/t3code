import {
  type Assistant,
  type AssistantId,
  AssistantMcpServer,
  type AssistantTeam,
  type AssistantToolAccess,
  assistantDescendantIds,
  assistantIdFromThreadId,
  isAssistantThreadId,
  AssistantAutonomy,
  DEFAULT_ASSISTANT_AUTONOMY,
  ProviderBudget,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  allTeams,
  countRecentTeamSends,
  sharedTeams,
  TEAM_SENDS_PER_HOUR,
} from "./AssistantTeams.ts";

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
  readonly reports_to: string | null;
  readonly ask_before_acting: number;
  readonly icon: string | null;
  readonly mcp_servers_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const BudgetJson = Schema.fromJsonString(ProviderBudget);
// A row that no longer decodes loses its cap rather than hiding every assistant.
const decodeBudgetOption = Schema.decodeOption(BudgetJson);
const decodeBudget = (json: string) => Option.getOrNull(decodeBudgetOption(json));
export const encodeBudget = Schema.encodeSync(BudgetJson);

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
  reportsTo: row.reports_to as AssistantId | null,
  askBeforeActing: row.ask_before_acting === 1,
  icon: row.icon,
  mcpServers: decodeMcpServers(row.mcp_servers_json),
  budget: row.budget_json === null ? null : decodeBudget(row.budget_json),
  autonomy:
    row.autonomy_json === null
      ? DEFAULT_ASSISTANT_AUTONOMY
      : Option.getOrElse(decodeAutonomyOption(row.autonomy_json), () => DEFAULT_ASSISTANT_AUTONOMY),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * An assistant with any org relation may only message its descendants; one with none is free.
 * Reports answer through the run their leader waits on, so a message upward never exists.
 * Teammates are the exception: `AssistantDirectory.mayMessage` lets them message each other in
 * any direction and `teamSendLimited` caps how often, which is what stops a loop there.
 */
export function assistantMayMessage(
  edges: ReadonlyArray<{ readonly id: string; readonly reportsTo: string | null }>,
  senderId: string,
  targetId: string,
): boolean {
  if (senderId === targetId) return true;
  const related = (id: string) =>
    edges.some((edge) => (edge.id === id ? edge.reportsTo !== null : edge.reportsTo === id));
  return (
    !(related(senderId) || related(targetId)) ||
    assistantDescendantIds(edges, senderId).has(targetId)
  );
}

export interface AssistantDirectoryShape {
  /** True unless both are assistant threads and neither the org chart nor a shared team allows it. */
  readonly mayMessage: (sender: ThreadId, target: ThreadId) => Effect.Effect<boolean>;
  /** True when the pair share a team and the sender used up its hourly sends to teammates. */
  readonly teamSendLimited: (sender: ThreadId, target: ThreadId) => Effect.Effect<boolean>;
  /** The teams the assistant is in, with its active teammates; archived ones left out. */
  readonly teamsOf: (assistant: Assistant) => Effect.Effect<
    ReadonlyArray<{
      readonly team: AssistantTeam;
      readonly leader: Assistant | null;
      readonly teammates: ReadonlyArray<Assistant>;
    }>
  >;
  /** Who the assistant reports to and who reports to it, archived ones left out. */
  readonly teamOf: (assistant: Assistant) => Effect.Effect<{
    readonly leader: Assistant | null;
    readonly reports: ReadonlyArray<Assistant>;
  }>;
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
    mayMessage: Effect.fn("AssistantDirectory.mayMessage")(function* (senderThread, targetThread) {
      const sender = yield* directory.forThread(senderThread);
      if (Option.isNone(sender)) return true;
      const target = yield* directory.forThread(targetThread);
      if (Option.isNone(target)) return true;
      const rows = yield* sql<{
        readonly assistant_id: string;
        readonly reports_to: string | null;
      }>`
        SELECT assistant_id, reports_to FROM assistants`.pipe(Effect.orDie);
      const teams = yield* allTeams(sql).pipe(Effect.orDie);
      return (
        sharedTeams(teams, sender.value.assistant.id, target.value.assistant.id).length > 0 ||
        assistantMayMessage(
          rows.map((row) => ({ id: row.assistant_id, reportsTo: row.reports_to })),
          sender.value.assistant.id,
          target.value.assistant.id,
        )
      );
    }),
    teamSendLimited: Effect.fn("AssistantDirectory.teamSendLimited")(function* (
      senderThread,
      targetThread,
    ) {
      const sender = yield* directory.forThread(senderThread);
      const target = yield* directory.forThread(targetThread);
      if (Option.isNone(sender) || Option.isNone(target)) return false;
      const senderId = sender.value.assistant.id;
      const teams = (yield* allTeams(sql)).filter((team) => team.memberIds.includes(senderId));
      if (sharedTeams(teams, senderId, target.value.assistant.id).length === 0) return false;
      const peers = [...new Set(teams.flatMap((team) => team.memberIds))].filter(
        (id) => id !== senderId,
      );
      const now = yield* DateTime.now;
      return (
        (yield* countRecentTeamSends(sql, senderId, peers, DateTime.toEpochMillis(now))) >=
        TEAM_SENDS_PER_HOUR
      );
    }, Effect.orDie),
    teamsOf: Effect.fn("AssistantDirectory.teamsOf")(function* (assistant) {
      const all = (yield* live).map(toAssistant);
      return (yield* allTeams(sql))
        .filter((team) => team.memberIds.includes(assistant.id))
        .map((team) => ({
          team,
          leader: all.find((other) => other.id === team.leaderId) ?? null,
          teammates: all.filter(
            (other) => other.id !== assistant.id && team.memberIds.includes(other.id),
          ),
        }));
    }, Effect.orDie),
    teamOf: Effect.fn("AssistantDirectory.teamOf")(function* (assistant) {
      const all = (yield* live).map(toAssistant);
      return {
        leader: all.find((other) => other.id === assistant.reportsTo) ?? null,
        reports: all.filter((other) => other.reportsTo === assistant.id),
      };
    }),
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
