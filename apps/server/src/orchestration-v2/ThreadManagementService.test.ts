import { expect, it } from "@effect/vitest";
import {
  type Assistant,
  assistantThreadIdFor,
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { AgentScope } from "@t3tools/shared/AgentScope";

import { AssistantDirectory } from "../assistants/AssistantDirectory.ts";
import * as AskGate from "../assistants/AskBeforeActingGate.ts";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    // A client cannot claim a linked environment's origin, or a parent there.
    linkOrigin: { sessionId: "forged", label: "Somewhere else" },
    delegatedFrom: {
      environmentId: EnvironmentId.make("environment:elsewhere"),
      threadId: ThreadId.make("thread:elsewhere"),
      title: "Somewhere else",
    },
  };

  const stamped = ThreadManagementService.withCreationProvenance(command, {
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).not.toHaveProperty("linkOrigin");
  expect(stamped).not.toHaveProperty("delegatedFrom");
});

it("keeps a captured memory ceiling only for agent-created work", () => {
  const dispatch = (createdBy: "user" | "agent") =>
    ThreadManagementService.withCreationProvenance(
      {
        type: "delegated_task.request",
        memoryGrantCeiling: "read_write",
        commandId: CommandId.make("command:thread-management:memory"),
      } as unknown as OrchestrationV2Command,
      { createdBy, creationSource: createdBy === "user" ? "web" : "mcp" },
    );
  expect(dispatch("agent")).toMatchObject({ memoryGrantCeiling: "read_write" });
  expect(dispatch("user")).toMatchObject({ memoryGrantCeiling: "none" });
});

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread can wait past an ended run for the thread's delegated work", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-delegated");
    const threadId = ThreadId.make("thread:thread-management:wait-delegated");
    const runId = RunId.make("run:thread-management:wait-delegated");
    const wakeRunId = RunId.make("run:thread-management:wait-delegated:wake");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"], end: number) =>
      ({
        id,
        ordinal,
        status,
        startedAt: at(end - 1),
        completedAt: status === "running" ? null : at(end),
      }) as unknown as OrchestrationV2Run;
    // The run ended, but a task it delegated still runs and will wake the thread.
    let runs = [run(runId, 1, "completed", 1)];
    let subagents = [{ status: "running" }];
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "subagent.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                  messages: [],
                  subagents,
                  providerThreads: [],
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    // Without the option, the ended run is the answer, as before.
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).toMatchObject({ timedOut: false, run: { id: runId } });
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).not.toHaveProperty("resultRun");

    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60 * 60 * 1_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // A wait that returns early fails below instead of hanging here.
    yield* Effect.raceFirst(Deferred.await(subscribed), Fiber.await(fiber));
    // The task finishes; its delivery wakes the thread, whose next run answers.
    subagents = [{ status: "completed" }];
    runs = [...runs, run(wakeRunId, 2, "completed", 3)];
    yield* Queue.offer(events, stored(1, { type: "subagent.updated", payload: {} }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "completed" },
      resultRun: { id: wakeRunId, status: "completed" },
    });
  }),
);

it.effect("waitForThread settles delegated work on a thread rolled back past its only run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-rolled-back");
    const threadId = ThreadId.make("thread:thread-management:wait-rolled-back");
    const runId = RunId.make("run:thread-management:wait-rolled-back");
    const rolledBack = {
      id: runId,
      ordinal: 1,
      status: "rolled_back",
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(1_000),
    } as unknown as OrchestrationV2Run;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: () => Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [rolledBack],
              messages: [],
              subagents: [],
              providerThreads: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // Nothing will ever run there again, so a wait still open runs out here.
    yield* TestClock.adjust(Duration.millis(60_000));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "rolled_back" },
      resultRun: { id: runId, status: "rolled_back" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each(["live", "no-session", "unsupported-runtime"] as const)(
  "marks background work awaited on the thread's active provider thread with state %s",
  (state) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:background-wait");
      const providerThreadId = ProviderThreadId.make("provider-thread:background-wait");
      const providerSessionId = ProviderSessionId.make("provider-session:background-wait");
      const driver = ProviderDriverKind.make("claudeAgent");
      const now = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "tests", kind: "command" }],
        contextUsage: null,
        nativeMetadata: null,
        createdAt: now,
        updatedAt: now,
      };
      const calls: Array<{ providerThreadId: ProviderThreadId; awaited: boolean }> = [];
      const runtime = {
        driver,
        providerSessionId,
        ...(state === "unsupported-runtime"
          ? {}
          : {
              awaitBackgroundTasks: (input: {
                readonly providerThread: OrchestrationV2ProviderThread;
                readonly taskIds: ReadonlyArray<string>;
                readonly awaited: boolean;
              }) =>
                Effect.sync(() => {
                  calls.push({
                    providerThreadId: input.providerThread.id,
                    awaited: input.awaited,
                  });
                  return { matched: input.taskIds.filter((taskId) => taskId === "tests") };
                }),
            }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    deletedAt: null,
                    activeProviderThreadId: providerThreadId,
                  },
                  providerThreads: [providerThread],
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.succeed(state === "no-session" ? Option.none() : Option.some(runtime)),
            }),
          ),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        return yield* service
          .awaitBackgroundTasks({ threadId, taskIds: ["tests", "finished"], awaited: true })
          .pipe(Effect.result);
      }).pipe(Effect.provide(Layer.merge(layerTest, ThreadCommandExecutor.layer)));

      if (state === "live") {
        expect(result).toMatchObject({
          success: { matched: ["tests"], unmatched: ["finished"] },
        });
        expect(calls).toEqual([{ providerThreadId, awaited: true }]);
      } else {
        expect(result).toMatchObject({
          failure: {
            _tag: "ThreadManagementBackgroundWaitError",
            reason: state === "no-session" ? "unavailable" : "unsupported",
          },
        });
        expect(calls).toEqual([]);
      }
    }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

it.effect.each([
  {
    name: "kills the thread's own agent and ends its turn",
    others: [] as ReadonlyArray<string>,
    killed: true,
    expected: { outcome: "killed", sharedWithThreadIds: [] },
    teardown: ["release"],
  },
  {
    name: "keeps a process another working thread shares and only ends this turn",
    others: ["thread:thread-management:force-stop:other"],
    killed: false,
    expected: {
      outcome: "shared",
      sharedWithThreadIds: ["thread:thread-management:force-stop:other"],
    },
    teardown: ["detach"],
  },
  {
    name: "still settles a finished run's background work in a shared process",
    others: ["thread:thread-management:force-stop:other"],
    killed: false,
    settledRun: true,
    expected: {
      outcome: "shared",
      sharedWithThreadIds: ["thread:thread-management:force-stop:other"],
    },
    teardown: ["detach"],
  },
  {
    name: "detaches when a sibling starts a turn just before the session is released",
    others: [] as ReadonlyArray<string>,
    killed: false,
    siblingBusy: true,
    expected: { outcome: "shared", sharedWithThreadIds: [] },
    teardown: ["release", "detach"],
  },
  {
    name: "reports a teardown that has not finished in time as still releasing",
    others: [] as ReadonlyArray<string>,
    killed: false,
    releaseHangs: true,
    expected: { outcome: "releasing", sharedWithThreadIds: [] },
    teardown: ["release"],
  },
])("Force stop $name", ({ others, killed, expected, teardown, ...row }) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:thread-management:force-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:force-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:force-stop");
    const runId = RunId.make("run:thread-management:force-stop");
    const dispatched: Array<OrchestrationV2Command | { readonly type: string }> = [];
    const teardowns: Array<string> = [];
    const tornDown = yield* Deferred.make<void>();
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          isLive: () => Effect.succeed(true),
          otherWorkingThreads: () => Effect.succeed(others.map((id) => ThreadId.make(id))),
          releaseUnlessBusy: () =>
            Effect.sync(() => teardowns.push("release")).pipe(
              Effect.andThen(
                "releaseHangs" in row ? Effect.never : Effect.succeed(!("siblingBusy" in row)),
              ),
            ),
          detach: () =>
            Effect.sync(() => teardowns.push("detach")).pipe(
              Effect.andThen(Deferred.succeed(tornDown, undefined)),
              Effect.asVoid,
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, deletedAt: null },
              runs: [
                {
                  id: runId,
                  ordinal: 1,
                  status: "settledRun" in row ? "completed" : "running",
                  activeAttemptId: "attempt",
                },
                // A queued follow-up neither supersedes the request nor becomes the target.
                { id: RunId.make("run:queued-follow-up"), ordinal: 2, status: "queued" },
              ],
              providerThreads: [{ id: providerThreadId, appThreadId: threadId, providerSessionId }],
              providerTurns: [
                {
                  id: "provider-turn:force-stop",
                  providerThreadId,
                  runAttemptId: "attempt",
                  status: "settledRun" in row ? "completed" : "running",
                },
              ],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(AgentScope, {
          ...AgentScope.defaultValue(),
          kill: () => Effect.succeed(killed),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      const stopping = yield* service.forceStopThread({ threadId, runId }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(stopping)).toEqual(expected);
      expect(dispatched).toMatchObject([
        {
          type: "thread.background-work.settle",
          providerThreadId,
          reason: "Force stopped by user",
        },
      ]);
      if (teardown.at(-1) === "detach") yield* Deferred.await(tornDown);
      expect(teardowns).toEqual(teardown);
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("Force stop refuses once a newer run has started, before killing anything", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:thread-management:force-stop-superseded");
    let killed = false;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, deletedAt: null },
              runs: [
                { id: RunId.make("run:stopped"), ordinal: 1, status: "running" },
                { id: RunId.make("run:newer"), ordinal: 2, status: "running" },
              ],
              providerThreads: [],
              providerTurns: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(
        Layer.succeed(AgentScope, {
          ...AgentScope.defaultValue(),
          kill: () => Effect.sync(() => (killed = true)),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const error = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* Effect.flip(
        service.forceStopThread({ threadId, runId: RunId.make("run:stopped") }),
      );
    }).pipe(Effect.provide(layerTest));
    expect(error.reason).toBe("superseded");
    expect(killed).toBe(false);
  }),
);

const guardThreads = {
  current: assistantThreadIdFor("helper", 2),
  old: assistantThreadIdFor("helper", 1),
  asker: assistantThreadIdFor("asker", 1),
  boxed: assistantThreadIdFor("boxed", 1),
  scoped: assistantThreadIdFor("scoped", 1),
  plain: ThreadId.make("thread:guard:plain"),
  /** A member's hidden thread for a group: never archived, deleted or restored by a client. */
  group: ThreadId.make("assistant:helper:g-0123456789abcdef"),
  /** A conversation in the project the scoped assistant lives in. */
  sameProject: ThreadId.make("thread:guard:same-project"),
  /** A conversation in the second project on the scoped assistant's list. */
  secondProject: ThreadId.make("thread:guard:second-project"),
};

const layerAssistantGuardTest = (dispatched: Array<unknown>) =>
  ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              id: guardThreads.current,
              projectId: ProjectId.make("project:guard"),
              deletedAt: null,
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
            },
          } as unknown as OrchestrationV2ThreadProjection),
        getThreadShell: (threadId) =>
          Effect.succeed({
            projectId: ProjectId.make(
              threadId === guardThreads.sameProject
                ? "project:scoped"
                : threadId === guardThreads.secondProject
                  ? "project:second"
                  : "project:guard",
            ),
          } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(AssistantDirectory, {
        teamsOf: () => Effect.succeed([]),
        sandboxEnvironmentId: Effect.succeedSome(EnvironmentId.make("environment-sandbox")),
        taskOwner: () => Effect.succeedNone,
        forThread: (threadId) =>
          Effect.succeed(
            threadId === guardThreads.plain
              ? Option.none()
              : Option.some({
                  assistant: {
                    toolAccess: "workspace-write",
                    archivedAt: null,
                    askBeforeActing: threadId === guardThreads.asker,
                    workspace: threadId === guardThreads.boxed ? "sandbox" : "host",
                    scope: threadId === guardThreads.scoped ? "project" : "all",
                    projectId: ProjectId.make(
                      threadId === guardThreads.scoped ? "project:scoped" : "project:guard",
                    ),
                    projectIds:
                      threadId === guardThreads.scoped
                        ? [ProjectId.make("project:scoped"), ProjectId.make("project:second")]
                        : [],
                  } as unknown as Assistant,
                  current: threadId === guardThreads.current,
                }),
          ),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(layerReceiptsTest),
    Layer.provideMerge(AskGate.gateLayer),
  );

it.effect.each([
  [
    "above its tool access",
    "current",
    { type: "thread.runtime-mode.set", runtimeMode: "full-access" },
    "capped",
  ],
  [
    "within its tool access",
    "current",
    { type: "thread.runtime-mode.set", runtimeMode: "approval-required" },
    null,
  ],
  ["archiving the current thread", "current", { type: "thread.archive" }, "Reset it"],
  ["deleting the current thread", "current", { type: "thread.delete" }, "Reset it"],
  ["archiving an old generation", "old", { type: "thread.archive" }, null],
  ["restoring an old generation", "old", { type: "thread.unarchive" }, "Restore an earlier"],
  ["unarchiving the current thread", "current", { type: "thread.unarchive" }, null],
  [
    "any change on a plain thread",
    "plain",
    { type: "thread.runtime-mode.set", runtimeMode: "full-access" },
    null,
  ],
  ["archiving a plain thread", "plain", { type: "thread.archive" }, null],
  ["archiving a group thread", "group", { type: "thread.archive" }, "hidden thread for a group"],
  ["deleting a group thread", "group", { type: "thread.delete" }, "hidden thread for a group"],
  ["restoring a group thread", "group", { type: "thread.unarchive" }, "hidden thread for a group"],
  [
    "a group thread's other commands",
    "group",
    { type: "thread.runtime-mode.set", runtimeMode: "approval-required" },
    null,
  ],
] as const)("assistant guard: %s", ([, which, partial, refusal]) => {
  const dispatched: Array<unknown> = [];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const result = yield* Effect.flip(
      threads.dispatch({
        ...partial,
        commandId: CommandId.make("command:guard"),
        threadId: guardThreads[which],
      } as never),
    ).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (refusal === null) {
      expect(Option.isNone(result)).toBe(true);
      expect(dispatched).toHaveLength(1);
    } else {
      expect(Option.getOrThrow(result)).toMatchObject({
        _tag: "OrchestratorCommandRejectedError",
        cause: { message: expect.stringContaining(refusal) },
      });
      expect(dispatched).toEqual([]);
    }
  }).pipe(Effect.provide(layerAssistantGuardTest(dispatched)));
});

it.effect("assistant guard: a first message cannot rename an assistant thread", () => {
  const dispatched: Array<unknown> = [];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    for (const threadId of [guardThreads.current, guardThreads.plain]) {
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:guard:${threadId}`),
        threadId,
        messageId: MessageId.make(`message:guard:${threadId}`),
        text: "hi",
        titleSeed: "hi",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
    }
    expect(dispatched.map((command) => "titleSeed" in (command as object))).toEqual([false, true]);
  }).pipe(Effect.provide(layerAssistantGuardTest(dispatched)));
});

it.effect.each([
  ["any assistant messaging another", guardThreads.old, guardThreads.current, null],
  ["a plain thread messaging an assistant", undefined, guardThreads.current, null],
] as const)("assistant guard: %s", ([, sender, target, refusal]) => {
  const dispatched: Array<unknown> = [];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const result = yield* Effect.flip(
      threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:guard:send"),
        threadId: target,
        messageId: MessageId.make("message:guard:send"),
        text: "hi",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        ...(sender === undefined ? {} : { senderThreadId: sender }),
        createdBy: "agent",
        creationSource: "mcp",
      }),
    ).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (refusal === null) {
      expect(Option.isNone(result)).toBe(true);
      expect(dispatched).toHaveLength(1);
    } else {
      expect(Option.getOrThrow(result)).toMatchObject({
        cause: { message: expect.stringContaining(refusal) },
      });
      expect(dispatched).toEqual([]);
    }
  }).pipe(Effect.provide(layerAssistantGuardTest(dispatched)));
});

const asked = (threadId: ThreadId) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make("command:guard:ask"),
  threadId,
  messageId: MessageId.make("message:guard:ask"),
  text: "deploy it",
  attachments: [],
  dispatchMode: { type: "queue_after_active" as const },
  senderThreadId: guardThreads.asker,
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
});

it.effect.each([
  [
    "waiting for approval",
    { allowed: false, message: "Waiting for the user" },
    "Waiting for the user",
  ],
  ["declined", { allowed: false, message: AskGate.SEND_DECLINED }, "declined"],
  ["approved", { allowed: true, release: Effect.void }, null],
  ["no approval path installed", undefined, "asking is unavailable"],
] as const)("ask before acting: a send to an agent thread is %s", ([, approval, refusal]) => {
  const dispatched: Array<unknown> = [];
  const seen: Array<unknown> = [];
  return Effect.gen(function* () {
    const gate = yield* AskGate.AskBeforeActingGate;
    if (approval !== undefined) {
      yield* gate.install((input) =>
        Effect.sync(() => {
          seen.push({ target: input.targetThreadId, text: input.text });
          return approval;
        }),
      );
    }
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const result = yield* Effect.flip(threads.dispatch(asked(guardThreads.plain))).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (refusal === null) {
      expect(Option.isNone(result)).toBe(true);
      expect(dispatched).toHaveLength(1);
    } else {
      expect(Option.getOrThrow(result)).toMatchObject({
        cause: { message: expect.stringContaining(refusal) },
      });
      expect(dispatched).toEqual([]);
    }
    if (approval !== undefined) {
      expect(seen).toEqual([{ target: guardThreads.plain, text: "deploy it" }]);
    }
  }).pipe(Effect.provide(layerAssistantGuardTest(dispatched)));
});

it.effect("ask before acting: assistant targets and other senders skip the gate", () => {
  const dispatched: Array<unknown> = [];
  return Effect.gen(function* () {
    const gate = yield* AskGate.AskBeforeActingGate;
    yield* gate.install(() => Effect.die("the gate must not be asked"));
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch(asked(guardThreads.current));
    yield* threads.dispatch({ ...asked(guardThreads.plain), senderThreadId: guardThreads.current });
    expect(dispatched).toHaveLength(2);
  }).pipe(Effect.provide(layerAssistantGuardTest(dispatched)));
});

it.effect.each([
  [
    "a sandboxed assistant sending into a thread on this Mac",
    "boxed",
    "plain",
    "environment-sandbox",
  ],
  ["a sandboxed assistant messaging another assistant", "boxed", "current", null],
  ["a host assistant sending into a thread on this Mac", "current", "plain", null],
] as const)("sandbox: %s", ([, sender, target, refusal]) => {
  const dispatched: Array<unknown> = [];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const result = yield* Effect.flip(
      threads.dispatch({
        ...asked(guardThreads[target]),
        senderThreadId: guardThreads[sender],
      }),
    ).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (refusal === null) {
      expect(Option.isNone(result)).toBe(true);
      expect(dispatched).toHaveLength(1);
    } else {
      expect(Option.getOrThrow(result)).toMatchObject({
        cause: { message: expect.stringContaining(`environmentId=${refusal}`) },
      });
      expect(dispatched).toEqual([]);
    }
  }).pipe(Effect.provide(layerAssistantGuardTest(dispatched)));
});

it.effect.each([
  ["a project assistant sending into its own project", "scoped", "sameProject", null],
  ["a project assistant sending into its second project", "scoped", "secondProject", null],
  ["a project assistant sending into a project off its list", "scoped", "plain", "your list"],
  ["a project assistant messaging another assistant", "scoped", "current", null],
  ["an everywhere assistant sending into any project", "current", "plain", null],
] as const)("project scope: %s", ([, sender, target, refusal]) => {
  const dispatched: Array<unknown> = [];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const result = yield* Effect.flip(
      threads.dispatch({
        ...asked(guardThreads[target]),
        senderThreadId: guardThreads[sender],
      }),
    ).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (refusal === null) {
      expect(Option.isNone(result)).toBe(true);
      expect(dispatched).toHaveLength(1);
    } else {
      expect(Option.getOrThrow(result)).toMatchObject({
        cause: { message: expect.stringContaining(refusal) },
      });
      expect(dispatched).toEqual([]);
    }
  }).pipe(Effect.provide(layerAssistantGuardTest(dispatched)));
});

it.effect("ask before acting: a replayed command already under an approval skips the gate", () => {
  const dispatched: Array<unknown> = [];
  return Effect.gen(function* () {
    const gate = yield* AskGate.AskBeforeActingGate;
    yield* gate.install(() => Effect.die("the gate must not be asked"));
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const command = asked(guardThreads.plain);
    yield* receipts.insertIfAbsent({
      commandId: command.commandId,
      threadId: guardThreads.plain,
      commandType: "message.dispatch",
      acceptedAt: yield* DateTime.now,
      resultSequence: 1,
      status: "accepted",
      error: null,
    });
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch(command);
    expect(dispatched).toHaveLength(1);
  }).pipe(Effect.provide(layerAssistantGuardTest(dispatched)));
});

it.effect("ask before acting: an approval is given back when the send itself fails", () => {
  let released = 0;
  return Effect.gen(function* () {
    const gate = yield* AskGate.AskBeforeActingGate;
    yield* gate.install(() =>
      Effect.succeed({ allowed: true, release: Effect.sync(() => void (released += 1)) }),
    );
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* Effect.flip(threads.dispatch(asked(guardThreads.plain)));
    expect(released).toBe(1);
  }).pipe(
    Effect.provide(
      ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () => Effect.fail(new Error("gone") as never),
            dispatch: () => Effect.fail(new Error("send failed") as never),
          }),
        ),
        Layer.provide(
          Layer.succeed(AssistantDirectory, {
            teamsOf: () => Effect.succeed([]),
            sandboxEnvironmentId: Effect.succeedNone,
            taskOwner: () => Effect.succeedNone,
            forThread: () =>
              Effect.succeedSome({
                assistant: {
                  toolAccess: "full",
                  archivedAt: null,
                  askBeforeActing: true,
                } as Assistant,
                current: true,
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(layerReceiptsTest),
        Layer.provideMerge(AskGate.gateLayer),
      ),
    ),
  );
});
