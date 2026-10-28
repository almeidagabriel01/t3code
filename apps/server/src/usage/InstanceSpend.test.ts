import { assert, it } from "@effect/vitest";

import { aggregateInstanceSpend, type SpendTurn } from "./InstanceSpend.ts";

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
