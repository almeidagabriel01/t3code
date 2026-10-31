import {
  type AssistantSpend as AssistantSpendResult,
  AssistantError,
  assistantIdFromThreadId,
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

import * as InstanceSpend from "../usage/InstanceSpend.ts";
import {
  budgetPeriodBounds,
  ProviderBudgetGate,
  type BudgetRefusal,
} from "../usage/providerBudget.ts";
import * as UsageService from "../usage/UsageService.ts";
import { type AssistantRow, toAssistant } from "./AssistantDirectory.ts";

const PERIOD_DAYS = 30;
const DAY_MS = 86_400_000;

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

export class AssistantSpend extends Context.Service<
  AssistantSpend,
  {
    readonly read: (assistantId: string) => Effect.Effect<AssistantSpendResult, AssistantError>;
    /** Set only for an assistant thread whose blocking budget is exceeded. */
    readonly budgetRefusal: (threadId: string) => Effect.Effect<Option.Option<BudgetRefusal>>;
  }
>()("t3/assistants/AssistantSpend") {}

export const layer = Layer.effect(
  AssistantSpend,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const usage = yield* UsageService.UsageService;

    const findRow = Effect.fn("AssistantSpend.findRow")(function* (assistantId: string) {
      const rows = yield* sql<AssistantRow>`
        SELECT * FROM assistants WHERE assistant_id = ${assistantId}`.pipe(Effect.orDie);
      return rows[0];
    });

    /** Every generation of the assistant: ids run `assistant:<id>:<n>`, a range keeps it exact. */
    const loadTurns = Effect.fn("AssistantSpend.loadTurns")(function* (
      assistantId: string,
      sinceMs: number,
    ) {
      const since = DateTime.formatIso(DateTime.makeUnsafe(sinceMs));
      const from = `assistant:${assistantId}:`;
      const to = `assistant:${assistantId};`;
      const rows = yield* sql<{
        readonly at: string;
        readonly model: string | null;
        readonly usage: string | null;
        readonly instance_id: string | null;
      }>`
        SELECT COALESCE(turn.completed_at, turn.started_at) AS at,
          attempt.provider_instance_id AS instance_id,
          json_extract(run.payload_json, '$.modelSelection.model') AS model,
          json_extract(turn.payload_json, '$.turnTokenUsage') AS usage
        FROM orchestration_v2_projection_provider_turns AS turn
        JOIN orchestration_v2_projection_run_attempts AS attempt
          ON attempt.attempt_id = turn.run_attempt_id
        LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
        WHERE turn.thread_id >= ${from} AND turn.thread_id < ${to}
          AND turn.status != 'pending' AND COALESCE(turn.completed_at, turn.started_at) >= ${since}`.pipe(
        Effect.orDie,
      );
      return rows.map((row) => ({
        // Keyed by assistant so one budget row aggregates all of them.
        providerInstanceId: assistantId,
        model: row.model,
        at: row.at,
        usage: row.usage === null ? null : Option.getOrNull(decodeTurnUsage(row.usage)),
      }));
    });

    const aggregate = Effect.fn("AssistantSpend.aggregate")(function* (
      assistantId: string,
      budget: ProviderBudget | null,
      timeZone: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const sinceMs = Math.min(
        now - (PERIOD_DAYS + 1) * DAY_MS,
        ...(budget === null ? [] : [budgetPeriodBounds({ ...budget, now }).startMs]),
      );
      const result = InstanceSpend.aggregateInstanceSpend({
        turns: yield* loadTurns(assistantId, sinceMs),
        pricing: yield* usage.pricingTables,
        now,
        timeZone,
        ...(budget === null ? {} : { budgets: { [assistantId]: budget } }),
      });
      return result.instances.find((row) => row.providerInstanceId === assistantId);
    });

    const read: AssistantSpend["Service"]["read"] = Effect.fn("AssistantSpend.read")(
      function* (assistantId) {
        const row = yield* findRow(assistantId);
        if (row === undefined) {
          return yield* new AssistantError({
            reason: "not_found",
            message: "Assistant not found.",
          });
        }
        const { budget } = toAssistant(row);
        const spend = yield* aggregate(
          assistantId,
          budget,
          budget?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        return {
          todayUsd: spend?.todayUsd ?? 0,
          periodUsd: spend?.periodUsd ?? 0,
          partial: spend?.partial ?? false,
          ...(spend?.budget === undefined ? {} : { budget: spend.budget }),
        };
      },
      Effect.catchDefect((cause) =>
        Effect.logWarning("assistant spend failed", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new AssistantError({ reason: "storage", message: "Could not read the spend." }),
            ),
          ),
        ),
      ),
    );

    const budgetRefusal: AssistantSpend["Service"]["budgetRefusal"] = Effect.fn(
      "AssistantSpend.budgetRefusal",
    )(function* (threadId) {
      const assistantId = assistantIdFromThreadId(threadId);
      if (assistantId === null) return Option.none();
      const row = yield* findRow(assistantId);
      const assistant = row === undefined ? null : toAssistant(row);
      const budget = assistant?.budget;
      if (assistant === null || !budget?.blockWhenExceeded) return Option.none();
      const status = (yield* aggregate(assistantId, budget, budget.timeZone))?.budget;
      if (status?.blocking !== true) return Option.none();
      const resets = new Intl.DateTimeFormat("en-US", {
        timeZone: status.timeZone,
        month: "short",
        day: "numeric",
      }).format(Date.parse(status.resetsAt));
      return Option.some({
        message: `${assistant.name} reached its $${budget.amountUsd.toFixed(2)} ${budget.period} limit. It resets on ${resets}, or raise the limit in the assistant's settings.`,
        resetsAt: status.resetsAt,
      });
    });

    return { read, budgetRefusal };
  }),
);

/** The turn-start check: the instance's budget first, then the assistant's own. */
export const layerBudgetGate = Layer.effect(
  ProviderBudgetGate,
  Effect.gen(function* () {
    const instances = yield* InstanceSpend.InstanceSpend;
    const assistants = yield* AssistantSpend;
    return (instanceId: string, threadId: string) =>
      instances
        .budgetRefusal(instanceId)
        .pipe(Effect.filterOrElse(Option.isSome, () => assistants.budgetRefusal(threadId)));
  }),
);
