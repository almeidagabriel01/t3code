import { assert, it } from "@effect/vitest";
import {
  CommandId,
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
});
