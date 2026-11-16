import { assert, it } from "@effect/vitest";
import {
  AssistantGroupAuthor,
  AssistantGroupMessageKind,
  ASSISTANT_GROUP_SETTLED_PAUSE_REASONS,
  AssistantGroupTaskKind,
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
    // Every author and kind, outside a request, in one, and in one the user wrote in afterwards.
    let seq = 0;
    for (const author of authors) {
      for (const kind of kinds) {
        for (const shape of ["none", "open", "answered"] as const) {
          const id = `m${(seq += 1)}`;
          const requestId = shape === "none" ? undefined : id;
          yield* sql`INSERT INTO assistant_group_messages
            (message_id, team_id, seq, author, kind, text, request_id, created_at)
            VALUES (${id}, 'g', ${seq}, ${author}, ${kind}, 'x', ${requestId ?? null}, 't')`;
          const lineSeq = seq;
          if (shape === "answered") {
            yield* sql`INSERT INTO assistant_group_messages
              (message_id, team_id, seq, author, kind, text, request_id, created_at)
              VALUES (${`${id}:answer`}, 'g', ${(seq += 1)}, 'user', 'message', 'x', ${id}, 't')`;
          }
          const [row] = yield* sql<{ readonly counts: number }>`
            SELECT ${sql.literal(countsAsUnreadSql("m"))} AS counts
            FROM assistant_group_messages m WHERE m.message_id = ${id}`;
          assert.equal(
            Boolean(row!.counts),
            assistantGroupCountsAsUnread(
              { author, kind, seq: lineSeq, requestId },
              shape === "answered" ? seq : undefined,
            ),
            `${author} ${kind} ${shape}`,
          );
        }
      }
    }
    // Every task alone, in every status, kind and pause reason, then every pair of statuses.
    const tasks = AssistantGroupTaskStatus.literals.flatMap((status) =>
      AssistantGroupTaskKind.literals.flatMap((kind) =>
        [null, ...ASSISTANT_GROUP_SETTLED_PAUSE_REASONS, "handoff_limit"].map((reason) => ({
          status,
          kind,
          reason,
        })),
      ),
    );
    const root = (status: AssistantGroupTaskStatus) => ({
      status,
      kind: "root" as const,
      reason: null,
    });
    const statuses = AssistantGroupTaskStatus.literals;
    const requests = [
      [],
      ...tasks.map((task) => [task]),
      ...statuses.flatMap((a) => statuses.map((b) => [root(a), root(b)])),
    ];
    for (const [index, request] of requests.entries()) {
      for (const [offset, task] of request.entries()) {
        yield* sql`INSERT INTO assistant_group_tasks
          (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status,
            reason, request_id, created_at, updated_at)
          VALUES (${`t${index}-${offset}`}, 'g', 'r', ${task.kind}, 'x', 'ada', 'do', ${task.status},
            ${task.reason}, ${`r${index}`}, 't', 't')`;
      }
      const [row] = yield* sql<{ readonly needs: number }>`
        SELECT ${sql.literal(tasksNeedUserSql(`'r${index}'`))} AS needs`;
      assert.equal(
        Boolean(row!.needs),
        assistantGroupTasksNeedUser(request),
        JSON.stringify(request),
      );
    }
  }).pipe(Effect.provide(database)),
);
