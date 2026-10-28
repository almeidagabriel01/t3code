import type { RateTable } from "../usage/usagePricing.ts";
import { priceTurnUsd } from "../usage/turnPricing.ts";

export interface KanbanPricingTables {
  readonly rates: RateTable;
  readonly overrides: RateTable;
  readonly aliases: ReadonlyMap<string, string>;
}

export interface CardUsageTurn {
  readonly model: string | null;
  readonly status: string;
  /** `turnTokenUsage` of the provider turn; input includes cache reads and writes. */
  readonly usage: {
    readonly usageStatus: "complete" | "partial" | "unavailable";
    readonly inputTokens?: number | undefined;
    readonly outputTokens?: number | undefined;
    readonly cachedInputTokens?: number | undefined;
    readonly cacheCreationTokens?: number | undefined;
    readonly reasoningTokens?: number | undefined;
  } | null;
}

export interface CardUsage {
  readonly costUsd: number | null;
  readonly totalTokens: number;
  readonly durationMs: number;
}

/**
 * Cost is null once any turn has partial or missing usage, or its model has no rate.
 * Tokens always count what is known. Subagent turns live in their own threads and are not summed.
 */
export function aggregateCardUsage(input: {
  readonly turns: ReadonlyArray<CardUsageTurn>;
  readonly runs: ReadonlyArray<{
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  }>;
  readonly pricing: KanbanPricingTables;
}): CardUsage {
  let costUsd: number | null = 0;
  let totalTokens = 0;
  for (const turn of input.turns) {
    if (turn.status === "pending") continue;
    const usage = turn.usage;
    totalTokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    if (usage === null || usage.usageStatus !== "complete" || turn.model === null) {
      costUsd = null;
      continue;
    }
    if (costUsd === null) continue;
    const cost = priceTurnUsd(input.pricing, turn.model, usage);
    costUsd = cost === null ? null : costUsd + cost;
  }
  let durationMs = 0;
  for (const run of input.runs) {
    if (run.startedAt === null || run.completedAt === null) continue;
    const span = Date.parse(run.completedAt) - Date.parse(run.startedAt);
    if (Number.isFinite(span) && span > 0) durationMs += span;
  }
  return { costUsd, totalTokens, durationMs: Math.round(durationMs) };
}
