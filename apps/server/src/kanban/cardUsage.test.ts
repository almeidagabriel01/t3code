import { assert, it } from "@effect/vitest";

import { aggregateCardUsage, type CardUsageTurn, type KanbanPricingTables } from "./cardUsage.ts";

const pricing: KanbanPricingTables = {
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
  aliases: new Map([["alias-model", "test-model"]]),
};
const complete = (model: string, usage: object = {}): CardUsageTurn => ({
  model,
  status: "completed",
  usage: { usageStatus: "complete", inputTokens: 1000, outputTokens: 500, ...usage },
});

it("prices complete turns, splitting cached input out of the input count", () => {
  const result = aggregateCardUsage({
    turns: [
      complete("test-model", { cachedInputTokens: 400, cacheCreationTokens: 100 }),
      complete("alias-model"),
    ],
    runs: [],
    pricing,
  });
  // turn 1: 500 uncached * 1e-6 + 400 * 1e-7 + 100 * 1.5e-6 + 500 * 2e-6 = 0.00169; turn 2: 0.002
  assert.closeTo(result.costUsd!, 0.00369, 1e-9);
  assert.strictEqual(result.totalTokens, 3000);
});

it("reports no cost when usage is partial, missing or unpriced, but still counts tokens", () => {
  const partial: CardUsageTurn = {
    model: "test-model",
    status: "completed",
    usage: { usageStatus: "partial", inputTokens: 10 },
  };
  assert.strictEqual(
    aggregateCardUsage({ turns: [complete("test-model"), partial], runs: [], pricing }).costUsd,
    null,
  );
  const missing: CardUsageTurn = { model: "test-model", status: "failed", usage: null };
  assert.strictEqual(
    aggregateCardUsage({ turns: [missing, complete("test-model")], runs: [], pricing }).costUsd,
    null,
  );
  const unpriced = aggregateCardUsage({ turns: [complete("mystery")], runs: [], pricing });
  assert.strictEqual(unpriced.costUsd, null);
  assert.strictEqual(unpriced.totalTokens, 1500);
});

it("ignores turns that never started and sums only finished run durations", () => {
  const result = aggregateCardUsage({
    turns: [{ model: "test-model", status: "pending", usage: null }],
    runs: [
      { startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:30.000Z" },
      { startedAt: "2026-01-01T01:00:00.000Z", completedAt: null },
      { startedAt: "2026-01-01T02:00:00.000Z", completedAt: "2026-01-01T02:00:10.000Z" },
    ],
    pricing,
  });
  assert.strictEqual(result.costUsd, 0);
  assert.strictEqual(result.durationMs, 100_000);
});
