import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { IdleCompactionSkip } from "../orchestration-v2/IdleCompactionService.ts";
import { openTaskStatusesSql } from "./groupChatSql.ts";

/**
 * A member's thread for one group request goes quiet for good once its tasks there are closed:
 * a new task in that request reopens it with its own run, which times a compaction again.
 */
export const layer = Layer.effect(
  IdleCompactionSkip,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return Effect.fn("groupIdleCompaction.skips")(
      function* (threadId) {
        const rows = yield* sql<{ readonly open: number }>`
          SELECT EXISTS (
            SELECT 1 FROM assistant_group_tasks t
            WHERE COALESCE(t.request_id, t.request_message_id) = r.request_id
              AND t.owner_id = r.assistant_id
              AND t.status IN (${sql.literal(openTaskStatusesSql)})
          ) AS open
          FROM assistant_group_request_threads r WHERE r.thread_id = ${threadId}`;
        return rows[0] !== undefined && rows[0].open === 0;
      },
      // An unreadable request keeps the compaction: skipping is only an optimization.
      Effect.orElseSucceed(() => false),
    );
  }),
);
