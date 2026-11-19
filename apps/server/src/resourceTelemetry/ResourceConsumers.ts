import {
  isAssistantGroupThreadId,
  type ResourceTelemetryConsumer,
  type ResourceTelemetrySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { consumerOf, withConsumers } from "./Owners.ts";

/** Names the consumer behind each agent process; telemetry starts before orchestration, so this runs on read. */
export class ResourceConsumers extends Context.Service<
  ResourceConsumers,
  {
    readonly annotate: (
      snapshot: ResourceTelemetrySnapshot,
    ) => Effect.Effect<ResourceTelemetrySnapshot>;
  }
>()("t3/resourceTelemetry/ResourceConsumers") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const cache = new Map<string, ResourceTelemetryConsumer>();

  const groupOf = Effect.fn("ResourceConsumers.groupOf")(function* (threadId: ThreadId) {
    if (!isAssistantGroupThreadId(threadId)) return null;
    const rows = yield* sql<{ readonly team_id: string }>`
      SELECT team_id FROM assistant_group_request_threads WHERE thread_id = ${threadId}
      UNION ALL
      SELECT team_id FROM assistant_group_threads WHERE thread_id = ${threadId}`;
    return rows[0]?.team_id ?? null;
  });

  const resolve = Effect.fn("ResourceConsumers.resolve")(function* (threadId: ThreadId) {
    const thread = yield* orchestrator.getThreadShell(threadId);
    if (thread === null) return null;
    return consumerOf({ thread, groupId: yield* groupOf(threadId), environmentId });
  });

  return ResourceConsumers.of({
    // Runs on every sample; the cache keeps it to one lookup per new agent process.
    annotate: Effect.fnUntraced(function* (snapshot) {
      if (snapshot.owners === undefined) return snapshot;
      return { ...snapshot, owners: yield* withConsumers(snapshot.owners, cache, resolve) };
    }),
  });
});

export const layer = Layer.effect(ResourceConsumers, make);
