import { priceUsage, type RateTable } from "./usagePricing.ts";

export interface PricingTables {
  readonly rates: RateTable;
  readonly overrides: RateTable;
  readonly aliases: ReadonlyMap<string, string>;
}

export interface TurnTokenUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
}

/** Cost of one provider turn (input includes cache reads and writes); null when its model has no rate. */
export function priceTurnUsd(
  pricing: PricingTables,
  model: string,
  usage: TurnTokenUsage,
): number | null {
  const cached = usage.cachedInputTokens ?? 0;
  const created = usage.cacheCreationTokens ?? 0;
  const priced = priceUsage(
    pricing.rates,
    {
      model: pricing.aliases.get(model) ?? model,
      totals: {
        uncachedInputTokens: Math.max(0, (usage.inputTokens ?? 0) - cached - created),
        cachedInputTokens: cached,
        cacheCreationTokens: created,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
      },
      speed: "standard",
      reportedCostUsd: null,
    },
    pricing.overrides,
  );
  return priced.costSource === "unpriced" ? null : priced.costUsd;
}
