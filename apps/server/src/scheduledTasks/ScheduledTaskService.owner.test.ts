import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const input = (id: string, projectId: string): ScheduledTaskUpsertInput => ({
  id: ScheduledTaskId.make(id),
  title: id,
  prompt: id,
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make(projectId),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
});

it.effect("a task an assistant made runs only in a project that assistant may still work in", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const launched: string[] = [];
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (launch) =>
              Effect.sync(() => {
                launched.push(launch.projectId);
                return { threadId: ThreadId.make(`thread:${launched.length}`) } as never;
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistants (assistant_id, handle, name, project_id, tool_access, created_at, updated_at, scope, project_ids_json)
      VALUES ('ada', 'ada', 'Ada', 'p:own', 'full', 't', 't', 'project', '["p:own"]'),
        ('roam', 'roam', 'Roam', 'p:own', 'full', 't', 't', 'all', '["p:own"]')`;
    yield* sql`
      INSERT INTO assistant_teams (team_id, name, member_ids_json, created_at, updated_at, project_ids_json)
      VALUES ('g', 'Core', '["ada"]', 't', 't', '["p:group"]')`;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const cases = [
        ["own", "p:own", "ada", "succeeded"],
        ["group", "p:group", "ada", "succeeded"],
        ["lost", "p:lost", "ada", "failed"],
        ["roam", "p:lost", "roam", "succeeded"],
        ["gone", "p:own", "deleted", "failed"],
        ["nobody", "p:lost", null, "succeeded"],
      ] as const;
      for (const [id, projectId, owner] of cases) {
        const { task } = yield* service.upsert(input(id, projectId), {
          memoryGrantCeiling: "none",
          ownerAssistantId: owner,
        });
        assert.equal(task.ownerAssistantId ?? null, owner);
        yield* service.runNow({ id: task.id });
      }
      const { tasks } = yield* service.list();
      for (const [id, , , status] of cases) {
        assert.equal(tasks.find((task) => task.id === id)?.lastRunStatus, status, id);
      }
      assert.deepEqual(launched, ["p:own", "p:group", "p:lost", "p:lost"]);
      assert.include(tasks.find((task) => task.id === "lost")?.lastRunError, "may no longer work");
      assert.include(tasks.find((task) => task.id === "gone")?.lastRunError, "no longer exists");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
