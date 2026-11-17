import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as StorageCleanup from "../../../storageCleanup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import * as WorktreeHandlers from "./handlers.ts";
import { WorktreeToolkit } from "./tools.ts";

const finish = (
  params: { worktreePath?: string },
  options: {
    readonly capabilities?: ReadonlyArray<"worktree" | "orchestration">;
    readonly error?: StorageCleanup.WorktreeFinishError;
  } = {},
) => {
  const calls: Array<{ threadId: string; worktreePath?: string | undefined }> = [];
  return Effect.gen(function* () {
    const toolkit = yield* WorktreeToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(WorktreeHandlers.layer)),
    );
    const chunk = yield* toolkit
      .handle("t3_worktree_finish", params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return { last: chunk.at(-1)!, calls };
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-worktree"),
      requestNamespace: "session-worktree",
      thread: {
        threadId: ThreadId.make("me"),
        providerSessionId: "session-worktree",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set<"worktree" | "orchestration">(options.capabilities ?? ["worktree"]),
      issuedAt: 1,
    }),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(StorageCleanup.StorageCleanup)({
          finishWorktree: (input) =>
            Effect.suspend(() => {
              calls.push(input);
              return options.error === undefined
                ? Effect.succeed({
                    status: "scheduled" as const,
                    worktreePath: input.worktreePath ?? "/wt/me",
                    detail: "Later.",
                  })
                : Effect.fail(options.error);
            }),
        }),
        Layer.mock(WorktreeMcpService.WorktreeMcpService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
};

describe("t3_worktree_finish", () => {
  it.effect("finishes the calling thread's worktree, or the one it names", () =>
    Effect.gen(function* () {
      const own = yield* finish({});
      expect(own.last.result).toMatchObject({ status: "scheduled", worktreePath: "/wt/me" });
      expect(own.calls).toEqual([{ threadId: "me", worktreePath: undefined }]);
      const named = yield* finish({ worktreePath: "/repo/.claude/worktrees/a" });
      expect(named.calls).toEqual([{ threadId: "me", worktreePath: "/repo/.claude/worktrees/a" }]);
    }),
  );

  it.effect("refuses credentials without worktree access and maps cleanup errors", () =>
    Effect.gen(function* () {
      const denied = yield* finish({}, { capabilities: ["orchestration"] });
      expect(denied.last.encodedResult).toMatchObject({ code: "capability_denied" });
      expect(denied.calls).toEqual([]);
      for (const [reason, code] of [
        ["thread-not-found", "thread_not_found"],
        ["project-not-found", "project_not_found"],
        ["unavailable", "operation_failed"],
      ] as const) {
        const failed = yield* finish(
          {},
          { error: new StorageCleanup.WorktreeFinishError({ reason }) },
        );
        expect(failed.last.encodedResult).toMatchObject({ code });
      }
    }),
  );
});
