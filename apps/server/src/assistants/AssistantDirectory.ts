import {
  type Assistant,
  type AssistantId,
  type AssistantToolAccess,
  assistantIdFromThreadId,
  isAssistantThreadId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  readonly created_at: string;
  readonly updated_at: string;
}

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
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface AssistantDirectoryShape {
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
  return AssistantDirectory.of({
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
  });
});

export const layer = Layer.effect(AssistantDirectory, make);
