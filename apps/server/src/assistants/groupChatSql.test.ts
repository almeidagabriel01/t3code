import { assert, it } from "@effect/vitest";
import {
  AssistantGroupAuthor,
  AssistantGroupMessageKind,
  AssistantGroupTaskId,
  AssistantGroupTaskKind,
  AssistantGroupTaskStatus,
  AssistantId,
  assistantGroupCountsAsUnread,
  assistantGroupTaskNeedsUser,
  assistantGroupTasksNeedUser,
  type AssistantGroupTask,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import { toAssistantTeam, type AssistantTeamRow } from "./AssistantTeams.ts";
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
      const tasks = request.map((status, offset) => ({
        id: AssistantGroupTaskId.make(`t${index}-${offset}`),
        parentId: null,
        kind: "root" as const,
        status,
        reason: null,
      }));
      assert.equal(Boolean(row!.needs), assistantGroupTasksNeedUser(tasks), request.join(","));
    }
  }).pipe(Effect.provide(database)),
);

it.effect("a tab waits on the user exactly when the contract says its request does", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureForkSchema();
    yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT)`;
    // Every status, reason and kind, under a parent that works on, waits on the user or was
    // stopped by them, in a request before or after the newest boundary.
    const parents = [
      ["completed", null],
      ["paused", "routing_failed"],
      ["paused", "stopped"],
    ] as const;
    let index = 0;
    for (const status of AssistantGroupTaskStatus.literals)
      for (const reason of [null, "stopped", "group_archived", "routing_failed"])
        for (const kind of AssistantGroupTaskKind.literals)
          for (const [parentStatus, parentReason] of kind === "root" ? [parents[0]] : parents)
            for (const beforeBoundary of [false, true]) {
              const team = `g${(index += 1)}`;
              const requestId = `${team}:r`;
              const [requestSeq, boundarySeq] = beforeBoundary ? [1, 2] : [2, 1];
              yield* sql`INSERT INTO assistant_teams
                (team_id, name, member_ids_json, created_at, updated_at)
                VALUES (${team}, 'Core', '[]', 't', 't')`;
              yield* sql`INSERT INTO assistant_group_messages
                (message_id, team_id, seq, author, kind, text, request_id, title, created_at)
                VALUES (${requestId}, ${team}, ${requestSeq}, 'user', 'message', 'x',
                  ${requestId}, 'Fix the totals', 't'),
                  (${`${team}:b`}, ${team}, ${boundarySeq}, 'user', 'boundary', 'new', NULL, NULL, 't')`;
              const own = { kind, status, reason };
              const parent = AssistantGroupTaskId.make(`${team}:p`);
              const tasks: ReadonlyArray<
                Pick<AssistantGroupTask, "id" | "parentId" | "kind" | "status" | "reason">
              > =
                kind === "root"
                  ? [{ id: parent, parentId: null, ...own }]
                  : [
                      {
                        id: parent,
                        parentId: null,
                        kind: "root",
                        status: parentStatus,
                        reason: parentReason,
                      },
                      { id: AssistantGroupTaskId.make(`${team}:c`), parentId: parent, ...own },
                    ];
              for (const task of tasks) {
                yield* sql`INSERT INTO assistant_group_tasks
                  (task_id, team_id, root_id, parent_id, kind, request_message_id, owner_id,
                    instruction, status, reason, request_id, created_at, updated_at)
                  VALUES (${task.id}, ${team}, ${`${team}:p`}, ${task.parentId}, ${task.kind},
                    ${requestId}, 'ada', 'do', ${task.status}, ${task.reason}, ${requestId}, 't', 't')`;
              }
              const label = JSON.stringify({ tasks, beforeBoundary });
              const needs = assistantGroupTasksNeedUser(tasks);
              const [request] = yield* sql<{ readonly needs: number }>`
                SELECT ${sql.literal(tasksNeedUserSql(`'${requestId}'`))} AS needs`;
              assert.equal(Boolean(request!.needs), needs, `request ${label}`);
              const [row] = yield* sql<AssistantTeamRow>`
                SELECT * FROM assistant_team_state WHERE team_id = ${team}`;
              const general = toAssistantTeam(row!).chat?.scopes?.find(
                (scope) => scope.projectId === null,
              );
              const waiting = beforeBoundary
                ? undefined
                : tasks.find((task) => needs && assistantGroupTaskNeedsUser(task, tasks));
              assert.equal(general?.waiting ?? false, waiting !== undefined, `tab ${label}`);
              assert.deepEqual(
                general?.waitingRequest,
                waiting === undefined
                  ? undefined
                  : {
                      requestId,
                      title: "Fix the totals",
                      reason: waiting.status === "failed" ? "failed" : "paused",
                      ...(waiting.reason === null ? {} : { taskReason: waiting.reason }),
                      assistantId: AssistantId.make("ada"),
                    },
                `waiting request ${label}`,
              );
            }
    // An untitled request (from before titles) reads as its first line without its mentions,
    // kept within the limit.
    const [waits] = yield* sql<{ readonly team_id: string; readonly message_id: string }>`
      SELECT t.team_id, t.request_id AS message_id FROM assistant_group_tasks t
      WHERE t.status = 'paused' AND t.reason = 'routing_failed' AND t.kind = 'root'
        AND EXISTS (SELECT 1 FROM assistant_group_messages m
          WHERE m.message_id = t.request_id AND m.seq = 2)
        AND NOT EXISTS (SELECT 1 FROM assistant_group_tasks o
          WHERE o.request_id = t.request_id AND o.task_id <> t.task_id)
      ORDER BY t.task_id LIMIT 1`;
    yield* sql`UPDATE assistant_group_messages SET title = NULL,
      text = ${`\n@ada, ${"y".repeat(100)}\nmore`} WHERE message_id = ${waits!.message_id}`;
    const [untitled] = yield* sql<AssistantTeamRow>`
      SELECT * FROM assistant_team_state WHERE team_id = ${waits!.team_id}`;
    assert.equal(
      toAssistantTeam(untitled!).chat?.scopes?.[0]?.waitingRequest?.title,
      `${"y".repeat(79)}…`,
    );
    // The rule itself, apart from any SQL: what the user stopped, an archive paused, a reply, or
    // a failed child (reported to its parent) waits on no one.
    const one = (
      status: AssistantGroupTaskStatus,
      reason: string | null,
      kind: AssistantGroupTaskKind = "root",
    ) =>
      assistantGroupTasksNeedUser([
        { id: AssistantGroupTaskId.make("t"), parentId: null, kind, status, reason },
      ]);
    assert.isFalse(one("paused", "stopped"));
    assert.isFalse(one("paused", "group_archived"));
    assert.isTrue(one("paused", "routing_failed"));
    assert.isTrue(one("paused", null));
    assert.isTrue(one("failed", null));
    assert.isFalse(one("failed", null, "child"));
    assert.isFalse(one("paused", "routing_failed", "reply"));
  }).pipe(Effect.provide(database)),
);
