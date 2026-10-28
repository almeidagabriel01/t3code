import { describe, expect, it } from "vite-plus/test";

import { budgetPercent, budgetPeriodLabel } from "./providerBudget.ts";

describe("provider budget labels", () => {
  const base = { amountUsd: 200, spentUsd: 50 };
  it("rounds the used share", () => {
    expect(budgetPercent(base)).toBe(25);
    expect(budgetPercent({ amountUsd: 3, spentUsd: 1 })).toBe(33);
  });
  it("names the period and its reset", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(
      budgetPeriodLabel(
        { period: "weekly", resetsAt: "2026-11-02T12:00:00Z", timeZone: "UTC" },
        now,
      ),
    ).toBe("this week · resets Mon");
    expect(
      budgetPeriodLabel(
        { period: "monthly", resetsAt: "2026-11-02T12:00:00Z", timeZone: "UTC" },
        now,
      ),
    ).toBe("this month · resets Nov 2");
    expect(
      budgetPeriodLabel(
        { period: "daily", resetsAt: "2026-10-29T00:00:00Z", timeZone: "UTC" },
        now,
      ),
    ).toBe("today · resets in 12h");
  });
});
