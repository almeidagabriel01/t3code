import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { startNextTurnAtTurnEnd } from "@t3tools/provider-testing/turnEndRace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

/** The turn-slot race on the Cursor adapter; each fake run ends when its deferred completes. */
export const cursorTurnSlotRace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-next-" });
  const runEnds: Array<Deferred.Deferred<"finished">> = [];
  const instanceId = ProviderInstanceId.make("cursor");
  const threadId = ThreadId.make("cursor-next-thread");
  const modelSelection = { instanceId, model: "composer-2.5" };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: workspace,
  });
  const adapter = yield* makeCursorAdapterV2({
    instanceId,
    environment: { HOME: workspace },
  }).pipe(
    Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
      assertComplete: Effect.void,
      open: () =>
        Effect.succeed({
          agentId: "native-cursor-next",
          listMessages: Effect.succeed([]),
          close: Effect.void,
          send: () =>
            Effect.gen(function* () {
              const runId = `native-cursor-run-${runEnds.length + 1}`;
              const ended = yield* Deferred.make<"finished">();
              runEnds.push(ended);
              return {
                agentId: "native-cursor-next",
                runId,
                wait: Deferred.await(ended).pipe(
                  Effect.map((status) => ({
                    id: runId,
                    requestId: `native-request-${runEnds.length}`,
                    status,
                    model: { id: "composer-2.5" },
                    durationMs: 1,
                  })),
                ),
                cancel: Effect.void,
              };
            }),
        }),
    }),
    Effect.provide(TestProviderHost.layer({ cwd: workspace })),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("cursor-next-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  const appThread = {
    id: threadId,
    projectId: ProjectId.make("cursor-next-project"),
    createdBy: "user" as const,
    creationSource: "web" as const,
    title: "Cursor next",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const turnInput = (runOrdinal: number) => ({
    threadId,
    providerThread,
    modelSelection,
    runtimePolicy,
    runId: RunId.make(`cursor-next-run-${runOrdinal}`),
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`cursor-next-attempt-${runOrdinal}`),
    rootNodeId: NodeId.make(`cursor-next-root-${runOrdinal}`),
    appThread,
    message: {
      messageId: MessageId.make(`cursor-next-message-${runOrdinal}`),
      createdBy: "user" as const,
      creationSource: "web" as const,
      text: `turn ${runOrdinal}`,
      attachments: [],
    },
  });
  const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  const exit = yield* startNextTurnAtTurnEnd({
    events: runtime.events.pipe(Stream.tap((event) => Effect.sync(() => seen.push(event)))),
    startFirst: runtime.startTurn(turnInput(1)),
    endFirst: Effect.suspend(() => Deferred.succeed(runEnds[0]!, "finished")),
    startNext: runtime.startTurn(turnInput(2)),
  });
  return { exit, seen };
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer)),
);
