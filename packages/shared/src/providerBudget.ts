import type { InstanceBudgetStatus } from "@t3tools/contracts";

export const budgetPercent = (budget: Pick<InstanceBudgetStatus, "amountUsd" | "spentUsd">) =>
  budget.amountUsd > 0 ? Math.round((budget.spentUsd / budget.amountUsd) * 100) : 0;

/** "this week · resets Mon"; daily budgets read in countdown form because their reset is soon. */
export function budgetPeriodLabel(
  budget: Pick<InstanceBudgetStatus, "period" | "resetsAt" | "timeZone">,
  now: number,
): string {
  const resetsAt = Date.parse(budget.resetsAt);
  if (budget.period === "daily") {
    const hours = Math.max(1, Math.round((resetsAt - now) / 3_600_000));
    return `today · resets in ${hours}h`;
  }
  const reset = new Intl.DateTimeFormat(
    "en-US",
    budget.period === "weekly"
      ? { weekday: "short", timeZone: budget.timeZone }
      : { month: "short", day: "numeric", timeZone: budget.timeZone },
  ).format(resetsAt);
  return `${budget.period === "weekly" ? "this week" : "this month"} · resets ${reset}`;
}
