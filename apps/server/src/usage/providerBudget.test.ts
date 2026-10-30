import { assert, it } from "@effect/vitest";
import type { ProviderBudget } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { aggregateInstanceSpend, type SpendTurn } from "./InstanceSpend.ts";
import { budgetBlockedMessage, budgetPeriodBounds, budgetStatus } from "./providerBudget.ts";

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const bounds = (period: "daily" | "weekly" | "monthly", timeZone: string, now: string) => {
  const { startMs, resetsAtMs } = budgetPeriodBounds({ period, timeZone, now: Date.parse(now) });
  return [iso(startMs), iso(resetsAtMs)];
};

it("daily periods follow the budget's time zone", () => {
  assert.deepStrictEqual(bounds("daily", "UTC", "2026-10-28T02:00:00Z"), [
    "2026-10-28T00:00:00.000Z",
    "2026-10-29T00:00:00.000Z",
  ]);
  // 02:00Z is still Oct 27 in Sao Paulo (UTC-3).
  assert.deepStrictEqual(bounds("daily", "America/Sao_Paulo", "2026-10-28T02:00:00Z"), [
    "2026-10-27T03:00:00.000Z",
    "2026-10-28T03:00:00.000Z",
  ]);
});

it("weekly periods start on Monday, including across a month boundary", () => {
  // 2026-10-28 is a Wednesday.
  assert.deepStrictEqual(bounds("weekly", "UTC", "2026-10-28T12:00:00Z"), [
    "2026-10-26T00:00:00.000Z",
    "2026-11-02T00:00:00.000Z",
  ]);
  // Sunday still belongs to the week that began the previous Monday.
  assert.deepStrictEqual(bounds("weekly", "UTC", "2026-11-01T23:59:00Z"), [
    "2026-10-26T00:00:00.000Z",
    "2026-11-02T00:00:00.000Z",
  ]);
  // 2026-12-02 (Wed): week starts in November.
  assert.deepStrictEqual(bounds("weekly", "UTC", "2026-12-02T10:00:00Z"), [
    "2026-11-30T00:00:00.000Z",
    "2026-12-07T00:00:00.000Z",
  ]);
});

it("monthly periods cover calendar months, year end and DST zones", () => {
  assert.deepStrictEqual(bounds("monthly", "UTC", "2026-12-31T23:00:00Z"), [
    "2026-12-01T00:00:00.000Z",
    "2027-01-01T00:00:00.000Z",
  ]);
  // Oct 31 22:00 in Sao Paulo is already Nov 1 UTC, but the budget month is still October.
  assert.deepStrictEqual(bounds("monthly", "America/Sao_Paulo", "2026-11-01T01:00:00Z"), [
    "2026-10-01T03:00:00.000Z",
    "2026-11-01T03:00:00.000Z",
  ]);
  // New York leaves DST on Nov 1, 2026.
  assert.deepStrictEqual(bounds("monthly", "America/New_York", "2026-10-15T12:00:00Z"), [
    "2026-10-01T04:00:00.000Z",
    "2026-11-01T04:00:00.000Z",
  ]);
  assert.deepStrictEqual(bounds("daily", "America/New_York", "2026-11-01T12:00:00Z"), [
    "2026-11-01T04:00:00.000Z",
    "2026-11-02T05:00:00.000Z",
  ]);
});

const budget: ProviderBudget = {
  amountUsd: 100,
  period: "monthly",
  warnAtPercent: 80,
  blockWhenExceeded: true,
  timeZone: "UTC",
};
const reset = { resetsAtMs: Date.parse("2026-11-01T00:00:00Z") };

it("moves from ok to warn to exceeded and only blocks when asked", () => {
  assert.strictEqual(budgetStatus(budget, 79.99, reset).state, "ok");
  assert.strictEqual(budgetStatus(budget, 80, reset).state, "warn");
  const exceeded = budgetStatus(budget, 100, reset);
  assert.strictEqual(exceeded.state, "exceeded");
  assert.isTrue(exceeded.blocking);
  assert.isFalse(budgetStatus({ ...budget, blockWhenExceeded: false }, 150, reset).blocking);
  assert.isFalse(budgetStatus(budget, 99, reset).blocking);
});

it("words the refusal with the amount, period and reset day", () => {
  assert.strictEqual(
    budgetBlockedMessage({ name: "Claude API", budget, resetsAt: "2026-11-01T00:00:00.000Z" }),
    "Claude API reached its $100.00 monthly budget. It resets on Nov 1, or raise the budget in Settings → Providers.",
  );
});

const turn = (at: string): SpendTurn => ({
  providerInstanceId: "a",
  model: "m",
  at,
  usage: { usageStatus: "complete", inputTokens: 1_000_000, outputTokens: 0 },
});
const pricing = {
  rates: new Map([
    [
      "m",
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

it("sums only turns since the budget period began, even beyond the 30-day window", () => {
  const result = aggregateInstanceSpend({
    turns: [
      turn("2026-10-27T00:00:00Z"),
      turn("2026-10-02T00:00:00Z"),
      turn("2026-09-30T23:00:00Z"),
    ],
    pricing,
    now: Date.parse("2026-10-28T12:00:00Z"),
    timeZone: "UTC",
    budgets: { a: budget, idle: { ...budget, period: "daily" } },
  });
  const a = result.instances.find((row) => row.providerInstanceId === "a")!;
  assert.strictEqual(a.budget?.spentUsd, 2);
  const idle = result.instances.find((row) => row.providerInstanceId === "idle")!;
  assert.strictEqual(idle.budget?.spentUsd, 0);
  assert.strictEqual(idle.budget?.state, "ok");
});

it("an unknown time zone counts periods in UTC, and the reset instant starts the next period", () => {
  for (const timeZone of ["Not/AZone", "  ", "UTC+3"]) {
    assert.deepStrictEqual(bounds("daily", timeZone, "2026-10-28T23:59:59Z"), [
      "2026-10-28T00:00:00.000Z",
      "2026-10-29T00:00:00.000Z",
    ]);
    assert.strictEqual(budgetStatus({ ...budget, timeZone }, 1, reset).timeZone, "UTC");
  }
  // The reset moment itself belongs to the new period; one millisecond earlier to the old one.
  assert.deepStrictEqual(bounds("monthly", "UTC", "2026-10-31T23:59:59.999Z"), [
    "2026-10-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
  ]);
  assert.deepStrictEqual(bounds("monthly", "UTC", "2026-11-01T00:00:00Z"), [
    "2026-11-01T00:00:00.000Z",
    "2026-12-01T00:00:00.000Z",
  ]);
  // A Sunday belongs to the week that started on the Monday before it.
  assert.deepStrictEqual(bounds("weekly", "UTC", "2026-11-01T12:00:00Z"), [
    "2026-10-26T00:00:00.000Z",
    "2026-11-02T00:00:00.000Z",
  ]);
  assert.strictEqual(
    budgetBlockedMessage({
      name: "X",
      budget: { ...budget, timeZone: "Not/AZone" },
      resetsAt: "2026-11-01T00:00:00.000Z",
    }),
    "X reached its $100.00 monthly budget. It resets on Nov 1, or raise the budget in Settings → Providers.",
  );
});

it("a warning at 100 percent warns only when the budget is exceeded, never before", () => {
  const full = { ...budget, warnAtPercent: 100 };
  assert.strictEqual(budgetStatus(full, 99.99, reset).state, "ok");
  assert.strictEqual(budgetStatus(full, 100, reset).state, "exceeded");
  assert.strictEqual(budgetStatus(budget, 0, reset).state, "ok");
});
