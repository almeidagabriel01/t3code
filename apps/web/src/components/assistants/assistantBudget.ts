import type { BudgetPeriod, ProviderBudget } from "@t3tools/contracts";

export interface BudgetDraft {
  readonly enabled: boolean;
  readonly amount: string;
  readonly period: BudgetPeriod;
  readonly warnAtPercent: string;
  readonly block: boolean;
}

/** An assistant's cap stops its turns by default: nobody is watching a long-lived one. */
export function budgetToDraft(budget: ProviderBudget | null): BudgetDraft {
  return {
    enabled: budget !== null,
    amount: budget === null ? "" : String(budget.amountUsd),
    period: budget?.period ?? "monthly",
    warnAtPercent: String(budget?.warnAtPercent ?? 80),
    block: budget?.blockWhenExceeded ?? true,
  };
}

export type BudgetDraftResult =
  | { readonly ok: true; readonly budget: ProviderBudget | null }
  | { readonly ok: false; readonly message: string };

export function budgetFromDraft(draft: BudgetDraft, timeZone: string): BudgetDraftResult {
  if (!draft.enabled) return { ok: true, budget: null };
  const amountUsd = Number(draft.amount.trim().replace(/^\$/, ""));
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { ok: false, message: "Enter a spending limit above $0." };
  }
  const warnAtPercent = Number(draft.warnAtPercent);
  if (!Number.isInteger(warnAtPercent) || warnAtPercent < 1 || warnAtPercent > 100) {
    return { ok: false, message: "Warn at must be a whole percent from 1 to 100." };
  }
  return {
    ok: true,
    budget: {
      amountUsd,
      period: draft.period,
      warnAtPercent,
      blockWhenExceeded: draft.block,
      timeZone,
    },
  };
}

const PERIOD_NOUN: Record<BudgetPeriod, string> = {
  daily: "today",
  weekly: "this week",
  monthly: "this month",
};

/** "$1.23 this month · estimated at API prices"; "at least" when some turns were unpriced. */
export function spendLine(spend: {
  readonly periodUsd: number;
  readonly partial: boolean;
  readonly budget?: { readonly spentUsd: number; readonly period: BudgetPeriod } | undefined;
}): string {
  const usd = spend.budget?.spentUsd ?? spend.periodUsd;
  const when = spend.budget ? PERIOD_NOUN[spend.budget.period] : "in the last 30 days";
  return `${spend.partial ? "At least " : ""}$${usd.toFixed(2)} ${when} · estimated at API prices`;
}
