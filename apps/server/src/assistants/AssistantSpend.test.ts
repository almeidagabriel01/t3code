import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as InstanceSpend from "../usage/InstanceSpend.ts";
import { ProviderBudgetGate } from "../usage/providerBudget.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as AssistantSpend from "./AssistantSpend.ts";

const pricing = {
  rates: new Map([
    [
      "test-model",
      {
        inputCostPerToken: 1e-6,
        outputCostPerToken: 0,
        cacheReadCostPerToken: 0,
        cacheCreationCostPerToken: 0,
        fast: null,
        ultrafast: null,
      },
    ],
  ]),
  overrides: new Map(),
  aliases: new Map<string, string>(),
};
const layer = AssistantSpend.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.mock(UsageService.UsageService)({ pricingTables: Effect.succeed(pricing) }),
    ),
  ),
);
const now = Date.parse("2026-10-20T12:00:00Z");
const budget = (amountUsd: number, blockWhenExceeded: boolean) =>
  JSON.stringify({
    amountUsd,
    period: "monthly",
    warnAtPercent: 80,
    blockWhenExceeded,
    timeZone: "UTC",
  });

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const assistant = (id: string, budgetJson: string | null) =>
    sql`
      INSERT INTO assistants (assistant_id, handle, name, project_id, tool_access, thread_id, generation, budget_json, created_at, updated_at)
      VALUES (${id}, ${id}, ${id}, 'p', 'full', ${`assistant:${id}:1`}, 1, ${budgetJson}, 'x', 'x')`;
  // One turn costing exactly $1 (1M input tokens).
  const turn = (threadId: string, n: number) =>
    Effect.gen(function* () {
      const at = "2026-10-19T12:00:00.000Z";
      const id = `${threadId}#${n}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${id}, ${threadId}, ${n}, 'codex', 'completed', ${at}, '{"modelSelection":{"model":"test-model"}}')`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_instance_id, provider_thread_id, status, payload_json)
        VALUES (${id}, ${threadId}, ${id}, 1, 'n', 'codex', 'codex', 'pt', 'completed', '{}')`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at, payload_json)
        VALUES (${id}, ${threadId}, ${id}, 'n', ${id}, ${n}, 'completed', ${at}, ${at}, '{"turnTokenUsage":{"usageStatus":"complete","inputTokens":1000000}}')`;
    });
  yield* assistant("a1", budget(2, true));
  yield* assistant("a10", budget(2, true));
  yield* assistant("a2", budget(0.5, false));
  yield* assistant("a3", null);
  // a1 spent in two generations; a10 shares its prefix; a2 and a3 have one turn each.
  yield* turn("assistant:a1:1", 1);
  yield* turn("assistant:a1:2", 2);
  yield* turn("assistant:a10:1", 1);
  yield* turn("assistant:a2:1", 1);
  yield* turn("assistant:a3:1", 1);
  yield* turn("plain-thread", 1);
  yield* TestClock.setTime(now);
});

it.effect("spend covers every generation of one assistant, and only that assistant", () =>
  Effect.gen(function* () {
    yield* seed;
    const spend = yield* AssistantSpend.AssistantSpend;
    const a1 = yield* spend.read("a1");
    assert.closeTo(a1.periodUsd, 2, 1e-9);
    assert.closeTo(a1.todayUsd, 0, 1e-9);
    assert.equal(a1.budget?.state, "exceeded");
    assert.closeTo((yield* spend.read("a10")).periodUsd, 1, 1e-9);
    // Without a budget the totals still come back, and no status.
    const a3 = yield* spend.read("a3");
    assert.closeTo(a3.periodUsd, 1, 1e-9);
    assert.isUndefined(a3.budget);
    assert.equal((yield* spend.read("missing").pipe(Effect.flip)).reason, "not_found");
  }).pipe(Effect.provide(layer)),
);

it.effect("only an exceeded, blocking budget refuses a turn", () =>
  Effect.gen(function* () {
    yield* seed;
    const spend = yield* AssistantSpend.AssistantSpend;
    const refused = yield* spend.budgetRefusal("assistant:a1:2");
    assert.isTrue(Option.isSome(refused));
    assert.include(Option.getOrThrow(refused).message, "a1 reached its $2.00 monthly limit.");
    assert.include(
      Option.getOrThrow(refused).message,
      "raise the limit in the assistant's settings.",
    );
    for (const threadId of [
      "assistant:a10:1", // under its cap
      "assistant:a2:1", // over, but not blocking
      "assistant:a3:1", // no budget
      "assistant:ghost:1", // no such assistant
      "plain-thread",
    ]) {
      assert.isTrue(Option.isNone(yield* spend.budgetRefusal(threadId)), threadId);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("the turn gate refuses an over-limit assistant, with the instance refusal first", () =>
  Effect.gen(function* () {
    yield* seed;
    const instanceRefusal = { message: "instance over", resetsAt: "2026-11-01T00:00:00.000Z" };
    const refusedInstances = new Set(["refused-instance"]);
    const gate = yield* Effect.service(ProviderBudgetGate).pipe(
      Effect.provide(
        AssistantSpend.layerBudgetGate.pipe(
          Layer.provide(
            Layer.mock(InstanceSpend.InstanceSpend)({
              budgetRefusal: (id) =>
                Effect.succeed(
                  refusedInstances.has(id) ? Option.some(instanceRefusal) : Option.none(),
                ),
            }),
          ),
          Layer.provideMerge(layer),
        ),
      ),
    );
    const refusal = (instanceId: string, threadId: string) =>
      gate(instanceId, threadId).pipe(Effect.map(Option.getOrUndefined));
    assert.include((yield* refusal("codex", "assistant:a1:2"))?.message, "a1 reached its");
    assert.isUndefined(yield* refusal("codex", "assistant:a10:1"));
    assert.isUndefined(yield* refusal("codex", "plain-thread"));
    assert.equal(yield* refusal("refused-instance", "assistant:a1:2"), instanceRefusal);
    assert.equal(yield* refusal("refused-instance", "plain-thread"), instanceRefusal);
  }).pipe(Effect.provide(layer)),
);

it.effect("a spend read that blows up reports a storage error", () =>
  Effect.gen(function* () {
    yield* seed;
    const spend = yield* AssistantSpend.AssistantSpend;
    assert.equal((yield* spend.read("a1").pipe(Effect.flip)).reason, "storage");
  }).pipe(
    Effect.provide(
      AssistantSpend.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            SqlitePersistence.layerMemory,
            Layer.mock(UsageService.UsageService)({ pricingTables: Effect.die("pricing down") }),
          ),
        ),
      ),
    ),
  ),
);
