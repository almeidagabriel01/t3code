import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

/**
 * Stop lands after the adapter accepted a turn but before that turn is recorded, as when
 * `startTurn` returns before the adapter's own turn event is ingested.
 */
const stopDuringStart = (
  scenario:
    | "ingested-turn"
    | "recorded-turn"
    | "starting-snapshot"
    | "next-message"
    | "other-thread"
    | "never-released"
    | "stop-in-window",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("stop-during-start");
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
      const interrupts: Array<ProviderTurnId> = [];
      const firstInterrupt = yield* Deferred.make<void>();
      // The adapter refuses a new turn while it still owns one, like every adapter with a turn slot.
      let active: ProviderTurnId | null = null;
      let activeThread: ProviderThreadId | null = null;
      const honorInterrupts =
        scenario === "ingested-turn" ||
        scenario === "recorded-turn" ||
        scenario === "starting-snapshot";
      // The next start's own interrupt of the stopped turn, which it sends without waiting.
      const startInterrupt = yield* Deferred.make<void>();
      const turnOf = (
        turn: ProviderAdapter.ProviderAdapterV2TurnInput,
        status: OrchestrationV2ProviderTurn["status"],
        now: DateTime.Utc,
      ): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
        providerThreadId: turn.providerThread.id,
        nodeId: turn.rootNodeId,
        runAttemptId: turn.attemptId,
        nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
        ordinal: turn.providerTurnOrdinal,
        status,
        startedAt: now,
        completedAt: status === "running" ? null : now,
      });
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
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
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
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
                  if (active !== null && activeThread === turn.providerThread.id) {
                    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: `Turn ${active} is still active.`,
                      reason: "previous_turn_active",
                    });
                  }
                  started.push(turn);
                  active = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
                  activeThread = turn.providerThread.id;
                  // The first turn is announced by the test, after Stop.
                  if (started.length > 1) {
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: turnOf(turn, "running", yield* DateTime.now),
                    });
                  }
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: (interrupt) =>
                Effect.gen(function* () {
                  interrupts.push(interrupt.providerTurnId);
                  if (interrupts.length === 2) yield* Deferred.succeed(startInterrupt, undefined);
                  if (!honorInterrupts || interrupt.providerTurnId !== active) return;
                  active = null;
                  const turn = started.find(
                    (candidate) =>
                      ProviderTurnId.make(`provider-turn:${candidate.attemptId}`) ===
                      interrupt.providerTurnId,
                  );
                  if (turn === undefined) return;
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: turnOf(turn, "interrupted", yield* DateTime.now),
                  });
                }).pipe(Effect.ensuring(Deferred.succeed(firstInterrupt, undefined))),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:stop-during-start");
        const send = (id: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:stop-during-start"),
          title: "Stop during start",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* send("first");
        yield* worker.drain();
        const first = started[0]!;
        const firstTurnId = ProviderTurnId.make(`provider-turn:${first.attemptId}`);
        assert.equal(active, firstTurnId);

        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop"),
          threadId,
        });
        const stopped = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(stopped.runs[0]?.status, "interrupted");
        assert.deepEqual(stopped.providerTurns, []);

        const now = yield* DateTime.now;
        if (scenario === "recorded-turn") {
          // The turn was recorded after Stop read the projection but before Stop committed.
          yield* sink.write({
            events: [
              {
                id: EventId.make("late-turn"),
                type: "provider-turn.updated",
                threadId,
                runId: first.runId,
                nodeId: first.rootNodeId,
                providerInstanceId: instanceId,
                occurredAt: now,
                payload: turnOf(first, "running", now),
              },
            ],
          });
          yield* worker.drain();
          assert.deepEqual(interrupts, [firstTurnId]);
          return;
        }

        yield* worker.drain();
        assert.deepEqual(interrupts, [], "Stop's own effect runs before the turn is recorded");
        // The adapter announces the turn it accepted before Stop.
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: turnOf(first, "running", now),
        });
        yield* Deferred.await(firstInterrupt);
        assert.deepEqual(interrupts, [firstTurnId]);
        if (scenario === "ingested-turn") {
          assert.isNull(active);
          return;
        }
        if (scenario === "starting-snapshot") {
          assert.isNull(active);
          // The session is open; Stop reads the next run before its start writes "running".
          yield* send("second");
          const second = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
          assert.notEqual(second.status, "running");
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-second"),
            threadId,
          });
          // The start's native turn is recorded after Stop's read, before its effects run.
          const secondTurnId = ProviderTurnId.make(`provider-turn:${second.activeAttemptId}`);
          active = secondTurnId;
          yield* sink.write({
            events: [
              {
                id: EventId.make("late-second-turn"),
                type: "provider-turn.updated",
                threadId,
                runId: second.id,
                nodeId: second.rootNodeId!,
                providerInstanceId: instanceId,
                occurredAt: now,
                payload: {
                  ...turnOf(first, "running", now),
                  id: secondTurnId,
                  nodeId: second.rootNodeId!,
                  runAttemptId: second.activeAttemptId!,
                  ordinal: first.providerTurnOrdinal + 1,
                },
              },
            ],
          });
          yield* worker.drain();
          assert.deepEqual(interrupts, [firstTurnId, secondTurnId]);
          assert.isNull(active);
          return;
        }

        // The stopped turn is still running in the provider when the next message arrives.
        assert.equal(active, firstTurnId);
        const otherThreadId = ThreadId.make("thread:stop-during-start:other");
        yield* send("next");
        if (scenario === "other-thread") {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-other"),
            threadId: otherThreadId,
            projectId: ProjectId.make("project:stop-during-start"),
            title: "Another thread",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("other"),
            threadId: otherThreadId,
            messageId: MessageId.make("message:other"),
            text: "other",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        // The start is first claimed long after it was queued, as behind a slow effect on its thread.
        yield* TestClock.adjust("15 seconds");
        // The waiting start gives its worker slot back instead of sleeping in it.
        yield* worker.drain();
        yield* Deferred.await(startInterrupt);
        assert.deepEqual(interrupts, [firstTurnId, firstTurnId]);
        const waiting = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(waiting.runs[1]?.status, "starting");
        if (scenario === "other-thread") {
          // Work queued after the waiting start, on another thread, ran in the same drain.
          assert.deepEqual(
            started.map((turn) => turn.threadId),
            [threadId, otherThreadId],
          );
          return;
        }
        assert.lengthOf(started, 1);

        const nextOutcome = Effect.gen(function* () {
          const after = yield* orchestrator.getThreadProjection(threadId);
          return {
            after,
            failed: after.turnItems.some(
              (item) => item.runId === after.runs[1]?.id && item.type === "error",
            ),
            failure: after.turnItems.find(
              (item) => item.runId === after.runs[1]?.id && item.type === "error",
            ),
          };
        });
        if (scenario === "stop-in-window") {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-next"),
            threadId,
          });
          yield* TestClock.adjust("15 seconds");
          yield* worker.drain();
          const { after, failed } = yield* nextOutcome;
          // The Stop cancelled the waiting start: no provider call, no error.
          assert.lengthOf(started, 1);
          assert.equal(after.runs[1]?.status, "interrupted");
          assert.isFalse(failed);
          assert.deepEqual(
            after.turnItems
              .filter((item) => item.runId === after.runs[1]?.id)
              .map((item) => item.type),
            ["user_message", "run_interrupt_request", "run_interrupt_result"],
          );
          return;
        }
        if (scenario === "never-released") {
          yield* TestClock.adjust("9 seconds");
          yield* worker.drain();
          assert.lengthOf(started, 1);
          assert.isFalse((yield* nextOutcome).failed, "still inside the ten-second window");
          yield* TestClock.adjust("2 seconds");
          yield* worker.drain();
          // Past the window the start fails without asking the provider, saying why.
          const { after, failure } = yield* nextOutcome;
          assert.lengthOf(started, 1);
          assert.equal(after.runs[1]?.status, "failed");
          assert.equal(failure?.type, "error");
          assert.equal(
            failure?.type === "error" ? failure.failure?.message : undefined,
            "The stopped turn has not ended yet. Send the message again once it ends.",
          );
          return;
        }

        // Still running after one wait: the start keeps waiting.
        yield* TestClock.adjust("250 millis");
        yield* worker.drain();
        assert.lengthOf(started, 1);
        // The stopped turn ends and frees the slot.
        active = null;
        const endedAt = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("stopped-turn-ended"),
              type: "provider-turn.updated",
              threadId,
              runId: first.runId,
              nodeId: first.rootNodeId,
              providerInstanceId: instanceId,
              occurredAt: endedAt,
              payload: turnOf(first, "interrupted", endedAt),
            },
          ],
        });
        yield* TestClock.adjust("250 millis");
        yield* worker.drain();
        const { after, failed } = yield* nextOutcome;
        assert.lengthOf(started, 2);
        assert.equal(after.runs[1]?.status, "running");
        assert.isFalse(failed);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "stop-during-start" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  );

it.effect("Stop interrupts a turn the provider announces after Stop ended its run", () =>
  stopDuringStart("ingested-turn"),
);

it.effect("Stop interrupts a turn recorded between its read and its commit", () =>
  stopDuringStart("recorded-turn"),
);

it.effect("Stop interrupts a turn whose start ran while Stop read a starting run", () =>
  stopDuringStart("starting-snapshot"),
);

it.effect("the next message waits for the stopped turn the provider still runs, then starts", () =>
  stopDuringStart("next-message"),
);

it.effect("a start waiting for a stopped turn leaves its worker slot to other threads", () =>
  stopDuringStart("other-thread"),
);

it.effect("the next message gives up after the retry window when the slot never frees", () =>
  stopDuringStart("never-released"),
);

it.effect("a Stop during the retry window ends the start without an error", () =>
  stopDuringStart("stop-in-window"),
);
