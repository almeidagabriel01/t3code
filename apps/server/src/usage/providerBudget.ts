import type { BudgetPeriod, InstanceBudgetStatus, ProviderBudget } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

const validZone = (timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
};

/** Wall-clock fields of an instant in a zone, as if they were UTC. */
const zonedFields = (ms: number, timeZone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(ms)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
};

/** Instant at which the zone's wall clock reads local midnight of the given UTC-normalized date. */
const zonedMidnight = (localDateMs: number, timeZone: string): number => {
  let guess = localDateMs;
  // Two passes settle offsets that change between the guess and the answer (DST).
  for (let pass = 0; pass < 2; pass++) {
    guess = localDateMs - (zonedFields(guess, timeZone) - guess);
  }
  return guess;
};

/**
 * Budget periods are calendar periods in the budget's own `timeZone` (set by the client that saved
 * it), so the server, every client and the enforcement check agree on when a period rolls over.
 * Weeks start on Monday.
 */
export function budgetPeriodBounds(input: {
  readonly period: BudgetPeriod;
  readonly timeZone: string;
  readonly now: number;
}): { readonly startMs: number; readonly resetsAtMs: number } {
  const timeZone = validZone(input.timeZone);
  const local = DateTime.toPartsUtc(DateTime.makeUnsafe(zonedFields(input.now, timeZone)));
  const { year, day } = local;
  const month = local.month - 1;
  const [start, next] =
    input.period === "daily"
      ? [Date.UTC(year, month, day), Date.UTC(year, month, day + 1)]
      : input.period === "weekly"
        ? (() => {
            const monday = day - ((local.weekDay + 6) % 7);
            return [Date.UTC(year, month, monday), Date.UTC(year, month, monday + 7)];
          })()
        : [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)];
  return {
    startMs: zonedMidnight(start!, timeZone),
    resetsAtMs: zonedMidnight(next!, timeZone),
  };
}

export function budgetStatus(
  budget: ProviderBudget,
  spentUsd: number,
  bounds: { readonly resetsAtMs: number },
): InstanceBudgetStatus {
  const state =
    spentUsd >= budget.amountUsd
      ? "exceeded"
      : spentUsd >= (budget.amountUsd * budget.warnAtPercent) / 100
        ? "warn"
        : "ok";
  return {
    period: budget.period,
    amountUsd: budget.amountUsd,
    spentUsd,
    warnAtPercent: budget.warnAtPercent,
    resetsAt: DateTime.formatIso(DateTime.makeUnsafe(bounds.resetsAtMs)),
    timeZone: validZone(budget.timeZone),
    state,
    blocking: state === "exceeded" && budget.blockWhenExceeded,
  };
}

export function budgetBlockedMessage(input: {
  readonly name: string;
  readonly budget: ProviderBudget;
  readonly resetsAt: string;
}): string {
  const resets = new Intl.DateTimeFormat("en-US", {
    timeZone: validZone(input.budget.timeZone),
    month: "short",
    day: "numeric",
  }).format(Date.parse(input.resetsAt));
  return `${input.name} reached its $${input.budget.amountUsd.toFixed(2)} ${input.budget.period} budget. It resets on ${resets}, or raise the budget in Settings → Providers.`;
}

export interface BudgetRefusal {
  readonly message: string;
  readonly resetsAt: string;
}

/** Asked before a provider turn starts; the default allows everything so unwired layers stay open. */
export const ProviderBudgetGate = Context.Reference<
  (instanceId: string, threadId: string) => Effect.Effect<Option.Option<BudgetRefusal>>
>("t3/usage/ProviderBudgetGate", {
  defaultValue: () => () => Effect.succeedNone,
});
