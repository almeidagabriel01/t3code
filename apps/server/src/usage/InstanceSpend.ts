import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  ProviderInstanceId,
  type InstanceSpendResult,
  type ProviderBudget,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { priceTurnUsd, type PricingTables, type TurnTokenUsage } from "./turnPricing.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  budgetBlockedMessage,
  budgetPeriodBounds,
  budgetStatus,
  type BudgetRefusal,
} from "./providerBudget.ts";
import * as UsageService from "./UsageService.ts";

const PERIOD_DAYS = 30;
const DAY_MS = 86_400_000;

export interface SpendTurn {
  readonly providerInstanceId: string;
  readonly model: string | null;
  readonly at: string;
  readonly usage: (TurnTokenUsage & { readonly usageStatus: string }) | null;
}

/** Turns with missing usage or no known rate still count as partial; priced turns always add up. */
export function aggregateInstanceSpend(input: {
  readonly turns: ReadonlyArray<SpendTurn>;
  readonly pricing: PricingTables;
  readonly now: number;
  readonly timeZone: string;
  readonly budgets?: Readonly<Record<string, ProviderBudget>>;
}): InstanceSpendResult {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone });
  const today = day.format(input.now);
  const since = input.now - PERIOD_DAYS * DAY_MS;
  const budgets = new Map(
    Object.entries(input.budgets ?? {}).map(([id, budget]) => [
      id,
      { budget, bounds: budgetPeriodBounds({ ...budget, now: input.now }) },
    ]),
  );
  type Row = { today: number; period: number; budget: number; partial: boolean };
  const byInstance = new Map<string, Row>(
    [...budgets.keys()].map((id) => [id, { today: 0, period: 0, budget: 0, partial: false }]),
  );
  for (const turn of input.turns) {
    const at = Date.parse(turn.at);
    const bounds = budgets.get(turn.providerInstanceId)?.bounds;
    const inBudget = bounds !== undefined && at >= bounds.startMs;
    if (!Number.isFinite(at) || at > input.now || (at < since && !inBudget)) continue;
    const row = byInstance.get(turn.providerInstanceId) ?? {
      today: 0,
      period: 0,
      budget: 0,
      partial: false,
    };
    byInstance.set(turn.providerInstanceId, row);
    const cost =
      turn.usage === null || turn.usage.usageStatus !== "complete" || turn.model === null
        ? null
        : priceTurnUsd(input.pricing, turn.model, turn.usage);
    if (cost === null) {
      row.partial = true;
      continue;
    }
    if (inBudget) row.budget += cost;
    if (at < since) continue;
    row.period += cost;
    if (day.format(at) === today) row.today += cost;
  }
  return {
    instances: [...byInstance].map(([providerInstanceId, row]) => ({
      providerInstanceId:
        providerInstanceId as InstanceSpendResult["instances"][number]["providerInstanceId"],
      todayUsd: row.today,
      periodUsd: row.period,
      partial: row.partial,
      ...(budgets.has(providerInstanceId)
        ? {
            budget: budgetStatus(
              budgets.get(providerInstanceId)!.budget,
              row.budget,
              budgets.get(providerInstanceId)!.bounds,
            ),
          }
        : {}),
    })),
  };
}

const TurnUsage = Schema.fromJsonString(
  Schema.Struct({
    usageStatus: Schema.Literals(["complete", "partial", "unavailable"]),
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
    cachedInputTokens: Schema.optional(Schema.Number),
    cacheCreationTokens: Schema.optional(Schema.Number),
    reasoningTokens: Schema.optional(Schema.Number),
  }),
);
const decodeTurnUsage = Schema.decodeUnknownOption(TurnUsage);

export class InstanceSpend extends Context.Service<
  InstanceSpend,
  {
    readonly read: (input: { readonly timeZone: string }) => Effect.Effect<InstanceSpendResult>;
    /** Set only for an instance whose blocking budget is exceeded. */
    readonly budgetRefusal: (instanceId: string) => Effect.Effect<Option.Option<BudgetRefusal>>;
  }
>()("t3/usage/InstanceSpend") {}

export const layer = Layer.effect(
  InstanceSpend,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const usage = yield* UsageService.UsageService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const loadTurns = Effect.fn("InstanceSpend.loadTurns")(function* (input: {
      readonly sinceMs: number;
      readonly instanceId?: string;
    }) {
      const since = DateTime.formatIso(DateTime.makeUnsafe(input.sinceMs));
      const instanceId = input.instanceId ?? null;
      const rows = yield* sql<{
        readonly instance_id: string | null;
        readonly at: string;
        readonly model: string | null;
        readonly usage: string | null;
      }>`
        SELECT attempt.provider_instance_id AS instance_id,
          COALESCE(turn.completed_at, turn.started_at) AS at,
          json_extract(run.payload_json, '$.modelSelection.model') AS model,
          json_extract(turn.payload_json, '$.turnTokenUsage') AS usage
        FROM orchestration_v2_projection_provider_turns AS turn
        JOIN orchestration_v2_projection_run_attempts AS attempt
          ON attempt.attempt_id = turn.run_attempt_id
        LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
        WHERE turn.status != 'pending' AND COALESCE(turn.completed_at, turn.started_at) >= ${since}
          AND (${instanceId} IS NULL OR attempt.provider_instance_id = ${instanceId})`.pipe(
        Effect.orDie,
      );
      return rows.flatMap((row) =>
        row.instance_id === null
          ? []
          : [
              {
                providerInstanceId: row.instance_id,
                model: row.model,
                at: row.at,
                usage: row.usage === null ? null : Option.getOrNull(decodeTurnUsage(row.usage)),
              },
            ],
      );
    });
    const read = Effect.fn("InstanceSpend.read")(function* (input: { readonly timeZone: string }) {
      const now = yield* Clock.currentTimeMillis;
      const budgets = (yield* settings.getSettings.pipe(Effect.orDie)).providerBudgets;
      // One day of slack so the window edge never depends on the client's zone; a budget period
      // can reach back further than 30 days (month start), so the window widens to cover it.
      const sinceMs = Math.min(
        now - (PERIOD_DAYS + 1) * DAY_MS,
        ...Object.values(budgets).map((budget) => budgetPeriodBounds({ ...budget, now }).startMs),
      );
      return aggregateInstanceSpend({
        turns: yield* loadTurns({ sinceMs }),
        pricing: yield* usage.pricingTables,
        now,
        timeZone: input.timeZone,
        budgets,
      });
    });
    const budgetRefusal = Effect.fn("InstanceSpend.budgetRefusal")(function* (instanceId: string) {
      const current = yield* settings.getSettings.pipe(Effect.orDie);
      const id = ProviderInstanceId.make(instanceId);
      const budget = current.providerBudgets[id];
      if (budget === undefined || !budget.blockWhenExceeded) return Option.none();
      const now = yield* Clock.currentTimeMillis;
      const { startMs } = budgetPeriodBounds({ ...budget, now });
      const spend = aggregateInstanceSpend({
        turns: yield* loadTurns({ sinceMs: startMs, instanceId }),
        pricing: yield* usage.pricingTables,
        now,
        timeZone: budget.timeZone,
        budgets: { [instanceId]: budget },
      }).instances.find((row) => row.providerInstanceId === instanceId)?.budget;
      if (spend?.blocking !== true) return Option.none();
      const instance = current.providerInstances[id];
      const name =
        instance?.displayName ??
        PROVIDER_DISPLAY_NAMES[(instance?.driver ?? instanceId) as ProviderDriverKind] ??
        instanceId;
      return Option.some({
        message: budgetBlockedMessage({ name, budget, resetsAt: spend.resetsAt }),
        resetsAt: spend.resetsAt,
      });
    });
    return { read, budgetRefusal };
  }),
);
