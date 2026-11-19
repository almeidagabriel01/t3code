import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** The id a task packet carries in its member thread: `group-task:<taskId>:<revision>`. */
export const parseTaskMessageId = (messageId: string) => {
  if (!messageId.startsWith("group-task:")) return null;
  const rest = messageId.slice("group-task:".length);
  const cut = rest.lastIndexOf(":");
  const revision = Number(rest.slice(cut + 1));
  return cut <= 0 || !Number.isInteger(revision) ? null : { taskId: rest.slice(0, cut), revision };
};

export type GroupRelayUntypedReason =
  | "task_missing"
  | "not_root"
  | "not_user"
  | "message_missing"
  | "thread_mismatch";

export type GroupRelaySource =
  | { readonly kind: "typed"; readonly text: string }
  | { readonly kind: "untyped"; readonly reason: GroupRelayUntypedReason };

/**
 * What the user typed behind each task packet a member thread received. Only a root task opened
 * by the user's own group message, delivered to the thread that owns its request, resolves; its
 * text is that message alone, never the packet's teammates, group instructions or memories.
 */
export const resolveGroupRelaySources = Effect.fn("AssistantGroups.resolveGroupRelaySources")(
  function* (sql: SqlClient.SqlClient, threadId: string, messageIds: ReadonlyArray<string>) {
    const resolved = new Map<string, GroupRelaySource>();
    const tasks = new Map<string, string[]>();
    for (const messageId of messageIds) {
      const parsed = parseTaskMessageId(messageId);
      if (parsed) tasks.set(parsed.taskId, [...(tasks.get(parsed.taskId) ?? []), messageId]);
    }
    if (!tasks.size) return resolved;
    const rows = yield* sql<{
      task_id: string;
      kind: string;
      author: string | null;
      message_kind: string | null;
      text: string | null;
      thread_id: string | null;
    }>`SELECT t.task_id,t.kind,m.author,m.kind AS message_kind,m.text,r.thread_id
      FROM assistant_group_tasks t
      LEFT JOIN assistant_group_messages m ON m.message_id=t.request_message_id
      LEFT JOIN assistant_group_request_threads r
        ON r.request_id=coalesce(t.request_id,t.request_message_id) AND r.assistant_id=t.owner_id
      WHERE t.task_id IN ${sql.in([...tasks.keys()])}`;
    const byTask = new Map(rows.map((row) => [row.task_id, row]));
    for (const [taskId, ids] of tasks) {
      const row = byTask.get(taskId);
      const source: GroupRelaySource =
        row === undefined
          ? { kind: "untyped", reason: "task_missing" }
          : row.kind !== "root"
            ? { kind: "untyped", reason: "not_root" }
            : row.text === null
              ? { kind: "untyped", reason: "message_missing" }
              : row.author !== "user" || row.message_kind !== "message"
                ? { kind: "untyped", reason: "not_user" }
                : row.thread_id !== threadId
                  ? { kind: "untyped", reason: "thread_mismatch" }
                  : { kind: "typed", text: row.text };
      for (const id of ids) resolved.set(id, source);
    }
    return resolved;
  },
);
