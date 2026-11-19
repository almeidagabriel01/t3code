import { assert, it } from "@effect/vitest";
import { AssistantId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InstanceSpend from "./InstanceSpend.ts";
import { aggregateInstanceSpend, type SpendTurn } from "./InstanceSpend.ts";
import * as UsageService from "./UsageService.ts";

const pricing = {
  rates: new Map([
    [
      "test-model",
      {
        inputCostPerToken: 1e-6,
        outputCostPerToken: 2e-6,
        cacheReadCostPerToken: 1e-7,
        cacheCreationCostPerToken: 1.5e-6,
        fast: null,
        ultrafast: null,
      },
    ],
  ]),
  overrides: new Map(),
  aliases: new Map<string, string>(),
};
// 1000 in + 500 out on test-model = 0.002 USD.
const turn = (
  providerInstanceId: string,
  at: string,
  over: Partial<SpendTurn> = {},
): SpendTurn => ({
  providerInstanceId,
  model: "test-model",
  at,
  usage: { usageStatus: "complete", inputTokens: 1000, outputTokens: 500 },
  ...over,
});
const now = Date.parse("2026-10-28T02:00:00Z");

it("groups by instance and splits today from the 30-day period in the client zone", () => {
  const result = aggregateInstanceSpend({
    turns: [
      turn("a", "2026-10-28T01:00:00Z"),
      // Still Oct 27 in Sao Paulo (UTC-3), already Oct 28 in UTC.
      turn("a", "2026-10-28T01:30:00Z"),
      turn("a", "2026-10-20T12:00:00Z"),
      turn("a", "2026-09-01T12:00:00Z"),
      turn("b", "2026-10-27T12:00:00Z"),
    ],
    pricing,
    now,
    timeZone: "UTC",
  });
  const a = result.instances.find((row) => row.providerInstanceId === "a")!;
  assert.closeTo(a.todayUsd, 0.004, 1e-9);
  assert.closeTo(a.periodUsd, 0.006, 1e-9);
  assert.isFalse(a.partial);
  const local = aggregateInstanceSpend({
    turns: [turn("a", "2026-10-28T01:00:00Z"), turn("a", "2026-10-27T20:00:00Z")],
    pricing,
    now,
    timeZone: "America/Sao_Paulo",
  });
  assert.closeTo(local.instances[0]!.todayUsd, 0.004, 1e-9);
  assert.closeTo(local.instances[0]!.periodUsd, 0.004, 1e-9);
});

it("marks partial when usage is missing or unpriced but still sums what is priced", () => {
  const result = aggregateInstanceSpend({
    turns: [
      turn("a", "2026-10-28T01:00:00Z"),
      turn("a", "2026-10-28T01:00:00Z", { usage: null }),
      turn("a", "2026-10-28T01:00:00Z", { model: "unknown-model" }),
    ],
    pricing,
    now,
    timeZone: "UTC",
  });
  assert.isTrue(result.instances[0]!.partial);
  assert.closeTo(result.instances[0]!.todayUsd, 0.002, 1e-9);
});

it("splits an instance's spend by consumer, folding assistant generations and capping the list", () => {
  const base = {
    environmentId: EnvironmentId.make("env"),
    providerInstanceId: ProviderInstanceId.make("a"),
  };
  const id = ThreadId.make;
  const assistantId = AssistantId.make("j");
  const thread = (threadId: string) => ({
    kind: "thread" as const,
    threadId: id(threadId),
    ...base,
  });
  const result = aggregateInstanceSpend({
    turns: [
      turn("a", "2026-10-20T12:00:00Z", {
        consumer: { kind: "assistant", threadId: id("assistant:j:1"), assistantId, ...base },
      }),
      turn("a", "2026-10-28T01:00:00Z", {
        consumer: { kind: "assistant", threadId: id("assistant:j:2"), assistantId, ...base },
      }),
      turn("a", "2026-10-28T01:00:00Z", {
        consumer: { kind: "subagent", threadId: id("child"), parentThreadId: id("t0"), ...base },
      }),
      ...Array.from({ length: 9 }, (_, n) =>
        turn("a", "2026-10-27T12:00:00Z", { consumer: thread(`t${n}`) }),
      ),
      turn("a", "2026-10-28T01:00:00Z"),
    ],
    pricing,
    now,
    timeZone: "UTC",
  });
  const a = result.instances[0]!;
  const consumers = a.consumers ?? [];
  assert.closeTo(a.periodUsd, 0.026, 1e-9);
  assert.strictEqual(consumers.length, 8);
  assert.strictEqual(consumers[0]!.consumer.threadId, "assistant:j:2");
  assert.closeTo(consumers[0]!.periodUsd, 0.004, 1e-9);
  assert.closeTo(consumers[0]!.todayUsd, 0.002, 1e-9);
  assert.strictEqual(consumers[1]!.consumer.threadId, "child");
  const kinds = Object.fromEntries((a.consumerKinds ?? []).map((row) => [row.kind, row.periodUsd]));
  assert.closeTo(kinds.thread!, 0.018, 1e-9);
  assert.closeTo(kinds.assistant!, 0.004, 1e-9);
  assert.closeTo(kinds.subagent!, 0.002, 1e-9);
});

it.effect("reads each turn's consumer from its thread's lineage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-10-27T12:00:00.000Z";
    const turn = (threadId: string, lineage: object | null) =>
      Effect.gen(function* () {
        if (lineage !== null) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
            VALUES (${threadId}, 'p', 't', 'codex', 'full-access', 'default', ${at}, ${at}, ${JSON.stringify({ lineage })})`;
        }
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${threadId}, ${threadId}, 1, 'codex', 'completed', ${at}, '{"modelSelection":{"model":"test-model"}}')`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_run_attempts (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_instance_id, provider_thread_id, status, payload_json)
          VALUES (${threadId}, ${threadId}, ${threadId}, 1, 'n', 'codex', 'a', 'pt', 'completed', '{}')`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at, payload_json)
          VALUES (${threadId}, ${threadId}, ${threadId}, 'n', ${threadId}, 1, 'completed', ${at}, ${at}, '{"turnTokenUsage":{"usageStatus":"complete","inputTokens":1000,"outputTokens":500}}')`;
      });
    yield* turn("root", { parentThreadId: null, relationshipToParent: null, rootThreadId: "root" });
    yield* turn("child", {
      parentThreadId: "root",
      relationshipToParent: "subagent",
      rootThreadId: "root",
    });
    yield* turn("assistant:j:1", null);
    yield* TestClock.setTime(now);
    const spend = yield* (yield* InstanceSpend.InstanceSpend).read({ timeZone: "UTC" });
    const kinds = (spend.instances[0]?.consumers ?? []).map((row) => ({
      kind: row.consumer.kind,
      environmentId: row.consumer.environmentId,
      parentThreadId: "parentThreadId" in row.consumer ? row.consumer.parentThreadId : null,
    }));
    assert.sameDeepMembers(kinds, [
      { kind: "thread", environmentId: "env-test", parentThreadId: null },
      { kind: "subagent", environmentId: "env-test", parentThreadId: "root" },
      { kind: "assistant", environmentId: "env-test", parentThreadId: null },
    ]);
  }).pipe(
    Effect.provide(
      InstanceSpend.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            SqlitePersistence.layerMemory,
            ServerSettings.layerTest(),
            Layer.mock(UsageService.UsageService)({ pricingTables: Effect.succeed(pricing) }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("env-test")),
            }),
          ),
        ),
      ),
    ),
  ),
);
