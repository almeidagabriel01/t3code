import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-notice-record" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.layer(layerTest)("thread.notice.record", (it) => {
  it.effect("adds one runless system notice per command, in order, without starting a run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:notice");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:notice"),
        threadId,
        projectId: ProjectId.make("project:thread-notice-record"),
        title: "Notice",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const record = (commandId: string, message: string) =>
        orchestrator.dispatch({
          type: "thread.notice.record",
          commandId: CommandId.make(commandId),
          threadId,
          message,
        });
      yield* record("notice-1", "Paused routine 'Daily report'");
      yield* record("notice-2", "Resumed routine 'Daily report'");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(projection.runs, 0);
      assert.deepEqual(
        projection.turnItems.map((item) => [item.type, item.runId]),
        [
          ["system_notice", null],
          ["system_notice", null],
        ],
      );
      assert.isBelow(projection.turnItems[0]!.ordinal, projection.turnItems[1]!.ordinal);
      assert.deepEqual(
        projection.turnItems.map((item) => (item.type === "system_notice" ? item.message : "")),
        ["Paused routine 'Daily report'", "Resumed routine 'Daily report'"],
      );
    }),
  );

  it.effect("a notice recorded while a run is in flight stays out of the run and in order", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:notice-in-flight");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:notice-in-flight"),
        threadId,
        projectId: ProjectId.make("project:thread-notice-record"),
        title: "Notice",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const send = (id: string, text: string, type: "start_immediately" | "queue_after_active") =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${id}`),
          threadId,
          messageId: MessageId.make(`message:${id}`),
          text,
          attachments: [],
          dispatchMode: { type },
          createdBy: "user",
          creationSource: "web",
        });
      yield* send("first", "Do the work", "start_immediately");
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(before.runs, 1);
      const run = before.runs[0]!;
      assert.notInclude(["completed", "failed", "interrupted"], run.status);

      yield* orchestrator.dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make("notice:in-flight"),
        threadId,
        message: "Paused routine 'Daily report'",
      });
      yield* send("second", "Next", "queue_after_active");

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const notice = projection.turnItems.find((item) => item.type === "system_notice")!;
      // The notice joins no run and is no message, so nothing the agent reads carries it.
      assert.isNull(notice.runId);
      assert.deepEqual(
        projection.messages.map((message) => message.text),
        ["Do the work", "Next"],
      );
      assert.equal(projection.runs[0]!.id, run.id);
      assert.equal(projection.runs[0]!.status, run.status);
      // A notice sorts after what the thread already shows, never above its first turn.
      assert.isAbove(notice.ordinal, run.ordinal * 1_000_000);
      for (const item of before.turnItems) assert.isBelow(item.ordinal, notice.ordinal);
      yield* orchestrator.dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make("notice:in-flight-2"),
        threadId,
        message: "Resumed routine 'Daily report'",
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      const notices = after.turnItems.filter((item) => item.type === "system_notice");
      assert.deepEqual(
        notices.map((item) => (item.type === "system_notice" ? item.message : "")),
        ["Paused routine 'Daily report'", "Resumed routine 'Daily report'"],
      );
      assert.equal(notices[0]!.ordinal, notice.ordinal);
      assert.isBelow(notices[0]!.ordinal, notices[1]!.ordinal);
    }),
  );
});
