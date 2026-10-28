import type { InstanceSpendResult } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { priceTurnUsd, type PricingTables, type TurnTokenUsage } from "./turnPricing.ts";
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
}): InstanceSpendResult {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone });
  const today = day.format(input.now);
  const since = input.now - PERIOD_DAYS * DAY_MS;
  const byInstance = new Map<string, { today: number; period: number; partial: boolean }>();
  for (const turn of input.turns) {
    const at = Date.parse(turn.at);
    if (!Number.isFinite(at) || at < since || at > input.now) continue;
    const row = byInstance.get(turn.providerInstanceId) ?? { today: 0, period: 0, partial: false };
    byInstance.set(turn.providerInstanceId, row);
    const cost =
      turn.usage === null || turn.usage.usageStatus !== "complete" || turn.model === null
        ? null
        : priceTurnUsd(input.pricing, turn.model, turn.usage);
    if (cost === null) {
      row.partial = true;
      continue;
    }
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
  }
>()("t3/usage/InstanceSpend") {}

export const layer = Layer.effect(
  InstanceSpend,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const usage = yield* UsageService.UsageService;
    const read = Effect.fn("InstanceSpend.read")(function* (input: { readonly timeZone: string }) {
      const now = yield* Clock.currentTimeMillis;
      // One day of slack so the window edge never depends on the client's zone.
      const since = DateTime.formatIso(DateTime.makeUnsafe(now - (PERIOD_DAYS + 1) * DAY_MS));
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
        WHERE turn.status != 'pending' AND COALESCE(turn.completed_at, turn.started_at) >= ${since}`.pipe(
        Effect.orDie,
      );
      return aggregateInstanceSpend({
        turns: rows.flatMap((row) =>
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
        ),
        pricing: yield* usage.pricingTables,
        now,
        timeZone: input.timeZone,
      });
    });
    return { read };
  }),
);
