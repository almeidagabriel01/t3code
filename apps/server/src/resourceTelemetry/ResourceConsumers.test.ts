import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  type ResourceTelemetrySnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ResourceConsumers from "./ResourceConsumers.ts";

const memberThread = "assistant:ana:g-0123456789abcdef";
const requestThread = "assistant:bia:g-fedcba9876543210";
const providerInstanceId = ProviderInstanceId.make("codex");

const layer = ResourceConsumers.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === "deleted"
              ? null
              : ({
                  id: threadId,
                  providerInstanceId,
                  lineage: {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: threadId,
                  },
                } as unknown as OrchestrationV2ThreadShell),
          ),
      }),
      Layer.mock(ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("mac")),
      }),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "consumers-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

it.layer(layer)("ResourceConsumers", (it) => {
  it.effect("reads a member's group from either group thread table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO assistant_group_threads (team_id, assistant_id, thread_id)
        VALUES ('team:1', 'ana', ${memberThread})`;
      yield* sql`INSERT INTO assistant_group_request_threads
        (request_id, assistant_id, team_id, thread_id)
        VALUES ('req-1', 'bia', 'team:2', ${requestThread})`;
      const consumers = yield* ResourceConsumers.ResourceConsumers;
      const snapshot = yield* consumers.annotate({
        owners: [
          { kind: "agent", pid: 2, threadId: memberThread },
          { kind: "agent", pid: 3, threadId: requestThread },
          { kind: "agent", pid: 4, threadId: "deleted" },
        ],
      } as unknown as ResourceTelemetrySnapshot);
      expect(
        snapshot.owners?.map((owner) => (owner.kind === "agent" ? owner.consumer : null)),
      ).toEqual([
        {
          kind: "groupMember",
          threadId: ThreadId.make(memberThread),
          assistantId: "ana",
          groupId: "team:1",
          environmentId: "mac",
          providerInstanceId,
        },
        {
          kind: "groupMember",
          threadId: ThreadId.make(requestThread),
          assistantId: "bia",
          groupId: "team:2",
          environmentId: "mac",
          providerInstanceId,
        },
        undefined,
      ]);
    }),
  );
});
