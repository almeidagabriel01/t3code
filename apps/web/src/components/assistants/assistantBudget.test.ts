import { describe, expect, it } from "vite-plus/test";

import { budgetFromDraft, budgetToDraft, spendLine } from "./assistantBudget";

describe("assistant budget draft", () => {
  it("is off without a budget and sends null", () => {
    const draft = budgetToDraft(null);
    expect(draft).toMatchObject({ enabled: false, block: true, warnAtPercent: "80" });
    expect(budgetFromDraft(draft, "UTC")).toEqual({ ok: true, budget: null });
  });

  it("round-trips a budget and rejects bad numbers only while on", () => {
    const budget = {
      amountUsd: 5,
      period: "weekly",
      warnAtPercent: 70,
      blockWhenExceeded: false,
      timeZone: "UTC",
    } as const;
    expect(budgetFromDraft(budgetToDraft(budget), "UTC")).toEqual({ ok: true, budget });
    const on = { ...budgetToDraft(null), enabled: true };
    for (const amount of ["", "0", "0.001", "-1", "abc"]) {
      expect(budgetFromDraft({ ...on, amount }, "UTC").ok).toBe(false);
    }
    expect(budgetFromDraft({ ...on, amount: "$3.5", warnAtPercent: "101" }, "UTC").ok).toBe(false);
    expect(budgetFromDraft({ ...on, amount: "$3.5" }, "UTC")).toMatchObject({
      ok: true,
      budget: { amountUsd: 3.5, blockWhenExceeded: true },
    });
  });

  it("words the spend line", () => {
    expect(spendLine({ periodUsd: 9, partial: false })).toBe(
      "$9.00 in the last 30 days · estimated at API prices",
    );
    expect(
      spendLine({ periodUsd: 9, partial: true, budget: { spentUsd: 1.234, period: "monthly" } }),
    ).toBe("At least $1.23 this month · estimated at API prices");
  });
});
