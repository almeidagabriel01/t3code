import { assert, it } from "@effect/vitest";
import {
  AssistantGroupAuthor,
  AssistantGroupMessageKind,
  AssistantGroupTaskStatus,
  assistantGroupCountsAsUnread,
  assistantGroupTasksNeedUser,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import { countsAsUnreadSql, tasksNeedUserSql } from "./groupChatSql.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("the server's chat rules answer exactly as the contract's, for every value", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureForkSchema();
    const authors = AssistantGroupAuthor.literals;
    const kinds = AssistantGroupMessageKind.literals;
    for (const [index, author] of authors.entries()) {
      for (const [offset, kind] of kinds.entries()) {
        const id = `m${index}-${offset}`;
        yield* sql`INSERT INTO assistant_group_messages
          (message_id, team_id, seq, author, kind, text, request_id, created_at)
          VALUES (${id}, 'g', ${index * kinds.length + offset + 1}, ${author}, ${kind}, 'x', ${id}, 't')`;
        const [row] = yield* sql<{ readonly counts: number }>`
          SELECT ${sql.literal(countsAsUnreadSql("m"))} AS counts
          FROM assistant_group_messages m WHERE m.message_id = ${id}`;
        assert.equal(Boolean(row!.counts), assistantGroupCountsAsUnread({ author, kind }), id);
      }
    }
    // Every request of up to two tasks, in every pair of statuses.
    const statuses = AssistantGroupTaskStatus.literals;
    const requests = [[], ...statuses.flatMap((a) => [[a], ...statuses.map((b) => [a, b])])];
    for (const [index, request] of requests.entries()) {
      for (const [offset, status] of request.entries()) {
        yield* sql`INSERT INTO assistant_group_tasks
          (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status,
            request_id, created_at, updated_at)
          VALUES (${`t${index}-${offset}`}, 'g', 'r', 'root', 'x', 'ada', 'do', ${status},
            ${`r${index}`}, 't', 't')`;
      }
      const [row] = yield* sql<{ readonly needs: number }>`
        SELECT ${sql.literal(tasksNeedUserSql(`'r${index}'`))} AS needs`;
      assert.equal(Boolean(row!.needs), assistantGroupTasksNeedUser(request), request.join(","));
    }
  }).pipe(Effect.provide(database)),
);
