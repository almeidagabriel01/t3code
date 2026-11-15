import { expect, it } from "@effect/vitest";
import * as M from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { makeRecall } from "./MemoryRecall.ts";
import * as Store from "./MemoryStore.ts";

const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");

it.effect("recall names the projects it could not search", () =>
  Effect.gen(function* () {
    const searched: Array<string> = [];
    const recall = makeRecall({
      sql: yield* SqlClient.SqlClient,
      environmentId: M.EnvironmentId.make("env"),
      resolveProjectKey: (_space, { projectId }) =>
        projectId === "p1"
          ? Effect.fail(new Store.MemoryStoreConflict({ code: "unavailable" }))
          : Effect.succeed({ kind: "explicit", sharedProjectId: `shared-${projectId}` }),
      search: (input) => {
        if (input.scope?.kind === "project" && input.scope.projectKey.kind === "explicit")
          searched.push(input.scope.projectKey.sharedProjectId);
        return Effect.succeed({ items: [], projectionWatermark: 0, nextCursor: null });
      },
    });
    const projectIds = Array.from({ length: 14 }, (_, n) => M.ProjectId.make(`p${n}`));
    const result = yield* recall(
      { query: "deploy", memorySpaceId: space, projectIds },
      Effect.void,
    );
    expect(new Set(searched)).toEqual(
      new Set([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `shared-p${n}`)),
    );
    expect(result.note).toContain("p1 (its memory could not be resolved)");
    expect(result.note).toContain("p12, p13 (over the 12-project limit)");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
