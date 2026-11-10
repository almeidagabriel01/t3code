import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

it.effect("pausing and resuming an assistant's routine leaves a line in its conversation", () =>
  Effect.gen(function* () {
    const notices: Array<{ type: string; threadId: string; message: string }> = [];
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                projectId: ProjectId.make("project:test"),
                archivedAt: null,
                deletedAt: null,
              } as never),
            dispatch: (command) =>
              Effect.sync(() => void notices.push(command as (typeof notices)[number])) as never,
          }),
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
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const upsert = (id: string, threadId: string, enabled = true) =>
        service.upsert({
          id: ScheduledTaskId.make(id),
          title: "Daily report",
          prompt: "Report",
          enabled,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          threadId: ThreadId.make(threadId),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const { task } = yield* upsert("task:assistant", "assistant:ada:1");
      const { task: ordinary } = yield* upsert("task:ordinary", "thread:ordinary");
      yield* service.setEnabled({ id: task.id, enabled: false });
      // Unchanged: no second line.
      yield* service.setEnabled({ id: task.id, enabled: false });
      yield* service.setEnabled({ id: task.id, enabled: true });
      yield* service.setEnabled({ id: ordinary.id, enabled: false });
      // Saving the routine with its switch flipped, as the editor and `schedule_task` do, counts;
      // saving it unchanged, or a first save, does not.
      yield* upsert("task:assistant", "assistant:ada:1", false);
      yield* upsert("task:assistant", "assistant:ada:1", false);
      yield* upsert("task:ordinary", "thread:ordinary", true);
      yield* upsert("task:new", "assistant:ada:1", false);
      assert.deepEqual(
        notices.map(({ type, threadId, message }) => [type, threadId, message]),
        [
          ["thread.notice.record", "assistant:ada:1", "Paused routine 'Daily report'"],
          ["thread.notice.record", "assistant:ada:1", "Resumed routine 'Daily report'"],
          ["thread.notice.record", "assistant:ada:1", "Paused routine 'Daily report'"],
        ],
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
