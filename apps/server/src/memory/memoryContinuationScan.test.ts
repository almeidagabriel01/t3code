import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { selectContinuationCandidates } from "./memoryContinuationScan.ts";
import { delegatedChildThreadSql } from "./memorySourceScan.ts";

it.effect("the continuation scan runs on the reader connection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-continuation-reader-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const spans: Array<Tracer.Span> = [];
      const observe: Statement.Transformer = (statement, _sql, _fiber, span) => {
        const [query] = statement.compile();
        if (query.includes("WITH progress AS MATERIALIZED")) spans.push(span);
        return Effect.succeed(statement);
      };
      const rows = yield* selectContinuationCandidates(sql, {
        environmentId: "environment:test",
        watermark: 100,
        now: 0,
        limit: 10,
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, observe),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      );
      assert.deepEqual(rows, []);
      assert.equal(spans.length, 1);
      assert.equal(spans[0]?.attributes.get("db.connection"), "reader");
    }).pipe(Effect.provide(database));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("the scan's per-thread lookups use the thread event indexes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-continuation-plan-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = (query: string) =>
        sql
          .unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
          .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));
      assert.include(
        yield* plan(
          `SELECT 1 FROM orchestration_v2_projection_threads t WHERE ${delegatedChildThreadSql("t.thread_id")}`,
        ),
        "SEARCH c EXISTS USING INDEX orchestration_events_v2_",
      );
      assert.include(
        yield* plan(
          `SELECT (SELECT s.sequence FROM orchestration_events s WHERE s.application_event_version=2 AND s.aggregate_kind='thread' AND s.stream_id=t.thread_id AND s.event_type='run.updated' ORDER BY s.sequence DESC LIMIT 1) FROM orchestration_v2_projection_threads t`,
        ),
        "orchestration_events_v2_thread_type_sequence_idx",
      );
    }).pipe(Effect.provide(database));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
