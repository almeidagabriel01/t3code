import {
  type Assistant,
  type AssistantId,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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
 * Reports answer through the run their leader waits on, so a message upward never exists and
 * a loop of assistants messaging each other cannot form.
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
  /** True unless both are assistant threads and the org chart forbids the send. */
  readonly mayMessage: (sender: ThreadId, target: ThreadId) => Effect.Effect<boolean>;
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
      return assistantMayMessage(
        rows.map((row) => ({ id: row.assistant_id, reportsTo: row.reports_to })),
        sender.value.assistant.id,
        target.value.assistant.id,
      );
    }),
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
