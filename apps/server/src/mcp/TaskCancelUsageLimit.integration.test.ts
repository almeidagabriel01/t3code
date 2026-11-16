import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { layerProjectModelSelection } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

// A delegated child that fails on a usage limit reads usage_limited until it continues at the
// reset, and waits again when the continuation hits a limit too. Once its parent cancels the
// task, nothing waits for that continuation; with auto-resume off nothing continues it at all.
it.effect.each([
  {
    cancel: "after its limit",
    autoResume: true,
    cancelStatus: "cancelled",
    resumed: false,
    statuses: ["usage_limited", "cancelled", "cancelled"],
  },
  {
    cancel: "as its limit lands",
    autoResume: true,
    cancelStatus: "cancel_requested",
    resumed: false,
    statuses: ["cancelled", "cancelled", "cancelled"],
  },
  {
    cancel: "never",
    autoResume: true,
    cancelStatus: null,
    resumed: true,
    statuses: ["usage_limited", "usage_limited", "running"],
  },
  {
    cancel: "never",
    autoResume: false,
    cancelStatus: null,
    resumed: false,
    statuses: ["failed", "failed", "failed"],
  },
  {
    cancel: "never",
    autoResume: true,
    cancelStatus: null,
    resumed: true,
    limitAgain: true,
    statuses: ["usage_limited", "usage_limited", "running", "usage_limited"],
  },
] as const)(
  "a delegated child whose task is cancelled $cancel, auto-resume $autoResume, resumes at the reset: $resumed",
  ({ cancel, autoResume, cancelStatus, resumed, statuses, ...row }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("task-cancel-usage-limit");
        // Set while the provider's usage-limit result is already on its way.
        let limitInFlight: Effect.Effect<void> = Effect.void;
        const turns: Array<{
          readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
          readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
        }> = [];
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: modelSelection.model,
                  capabilities: ClaudeProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    turns.push({ turn, events });
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: null,
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                steerTurn: () => Effect.die("unused"),
                interruptTurn: () => Effect.suspend(() => limitInFlight),
                respondToRuntimeRequest: () => Effect.die("unused"),
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
        const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
          { name: "task-cancel-usage-limit" },
          layerAdapters,
          { runEffectWorker: false },
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const sweeps = new Map<string, Effect.Effect<void>>();
        const layerRecovery = UsageLimitRecoveryWorker.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Scheduler.Scheduler, {
                register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
                  Effect.gen(function* () {
                    const context = yield* Effect.context<R>();
                    sweeps.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
                  }),
              }),
              ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              ServerSettings.layerTest({ autoResumeLimitedThreads: autoResume }),
            ),
          ),
        );
        const layerTest = Layer.merge(
          OrchestratorMcpService.layer.pipe(
            Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
            Layer.provide(layerProjectModelSelection),
            Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          ),
          layerRecovery,
        ).pipe(
          Layer.provideMerge(layerOrchestration),
          Layer.provide(
            Layer.mergeAll(
              layerAdapters,
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(RemoteDelegation.RemoteDelegation)({}),
              ServerSettings.layerTest({ autoResumeLimitedThreads: autoResume }),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const sweep = Effect.andThen(
            Effect.suspend(() => sweeps.get("usage-limit-recovery")!),
            worker.drain(),
          );
          const parentThreadId = ThreadId.make("thread:task-cancel-limit-parent");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          const turnRunning = () =>
            watch(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-parent"),
            threadId: parentThreadId,
            projectId: ProjectId.make("project:task-cancel-limit"),
            title: "Parent",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const parentRunning = yield* turnRunning();
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-parent"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:start-parent"),
            text: "Delegate a review",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(parentRunning);

          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
          const childRunning = yield* turnRunning();
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make("delegate"),
            parentThreadId,
            parentRunId: parentRun.id,
            parentNodeId: parentRun.rootNodeId!,
            task: "Review the change",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();
          yield* Fiber.join(childRunning);
          const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
          const childThreadId = task.childThreadId!;
          const child = turns.find((entry) => entry.turn.threadId === childThreadId)!;
          const childTurn = (yield* orchestrator.getThreadProjection(childThreadId))
            .providerTurns[0]!;

          const scope: McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:task-cancel-limit"),
            requestNamespace: "provider-session:task-cancel-limit",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "provider-session:task-cancel-limit",
              providerInstanceId: instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const cancelTask = Effect.gen(function* () {
            const result = yield* service.cancelTask(scope, {
              taskId: task.id,
              clientRequestId: "cancel-task",
            });
            yield* worker.drain();
            return result.status;
          });

          const now = yield* DateTime.now;
          let resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
          const seen: Array<string> = [];
          const readStatus = Effect.gen(function* () {
            const result = yield* service.taskStatus(scope, task.id);
            seen.push(result.status);
            if (result.status === "usage_limited") assert.equal(result.resetAt, resetAt);
            else assert.isUndefined(result.resetAt);
          });
          const limitFailed = (entry: (typeof turns)[number]) =>
            watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === entry.turn.runId &&
                event.payload.status === "failed",
            );
          const limitEvents = (
            entry: (typeof turns)[number],
            providerTurn: typeof childTurn,
            failedAt: DateTime.Utc,
          ) =>
            Effect.forEach(
              [
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: { ...providerTurn, status: "failed", completedAt: failedAt },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: providerTurn.providerThreadId,
                  providerTurnId: providerTurn.id,
                  runOrdinal: entry.turn.runOrdinal,
                  failureItemOrdinal: 1,
                  status: "failed",
                  failure: {
                    class: "usage_limit",
                    message: "Claude usage limit reached.",
                    code: null,
                    retryable: null,
                    resetAt,
                  },
                  threadDisposition: "reusable",
                },
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
              (event) => Queue.offer(entry.events, event),
              { discard: true },
            );
          const childFailed = yield* limitFailed(child);
          const hitLimit = limitEvents(child, childTurn, now);
          let cancelled: string | null = null;
          if (cancel === "as its limit lands") {
            limitInFlight = hitLimit;
            cancelled = yield* cancelTask;
          } else {
            yield* hitLimit;
          }
          yield* Fiber.join(childFailed);
          yield* worker.drain();

          // The sweep runs every few seconds, so it arms the child before a parent reacts.
          yield* sweep;
          yield* readStatus;
          if (cancel === "after its limit") cancelled = yield* cancelTask;
          assert.equal(cancelled, cancelStatus);
          yield* readStatus;

          const continuationRunning = resumed ? yield* turnRunning() : undefined;
          yield* TestClock.adjust("1 minute");
          yield* sweep;
          if (continuationRunning !== undefined) yield* Fiber.join(continuationRunning);
          yield* readStatus;
          if ("limitAgain" in row) {
            // The running continuation hits a limit again, with a later reset.
            const limitLatestTurn = (minutes: number) =>
              Effect.gen(function* () {
                const entry = turns.at(-1)!;
                const providerTurn = (yield* orchestrator.getThreadProjection(
                  childThreadId,
                )).providerTurns.find((turn) => turn.runAttemptId === entry.turn.attemptId)!;
                const failed = yield* limitFailed(entry);
                const failedAt = yield* DateTime.now;
                resetAt = DateTime.formatIso(DateTime.add(failedAt, { minutes }));
                yield* limitEvents(entry, providerTurn, failedAt);
                yield* Fiber.join(failed);
                yield* worker.drain();
                yield* sweep;
              });
            yield* limitLatestTurn(5);
            yield* readStatus;
            // A continuation is a task of its own, and it waits the same way when the run that
            // continues it hits a limit too.
            const continuationTask = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).subagents.find((entry) => entry.id !== task.id)!;
            const nextRunning = yield* turnRunning();
            yield* TestClock.adjust("5 minutes");
            yield* sweep;
            yield* Fiber.join(nextRunning);
            yield* limitLatestTurn(10);
            const again = yield* service.taskStatus(scope, continuationTask.id);
            assert.deepEqual([again.status, again.resetAt], ["usage_limited", resetAt]);
          }
          assert.deepEqual(seen, [...statuses]);
          const childAfter = yield* orchestrator.getThreadProjection(childThreadId);
          assert.deepEqual(
            childAfter.messages.flatMap((message) =>
              message.role === "user" ? [message.text] : [],
            ),
            [
              "Review the change",
              ...Array.from(
                { length: !resumed ? 0 : "limitAgain" in row ? 2 : 1 },
                () => "Continue where you left off.",
              ),
            ],
          );
        }).pipe(Effect.provide(layerTest));
      }),
    ),
);
