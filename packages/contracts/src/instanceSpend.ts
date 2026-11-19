import * as Schema from "effect/Schema";

import { ForwardCompatibleArray } from "./baseSchemas.ts";
// Not in usage.ts: consumer.ts imports assistants.ts, which imports usage.ts.
import { ConsumerRef } from "./consumer.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { InstanceBudgetStatus } from "./usage.ts";

const ConsumerSpendUsd = { todayUsd: Schema.Number, periodUsd: Schema.Number };

/** One consumer's share of an instance's spend; an assistant's generations count as one. */
export const ConsumerSpend = Schema.Struct({
  consumer: ConsumerRef,
  ...ConsumerSpendUsd,
});
export type ConsumerSpend = typeof ConsumerSpend.Type;

export const ConsumerKindSpend = Schema.Struct({
  kind: Schema.Literals(["thread", "assistant", "groupMember", "subagent"]),
  ...ConsumerSpendUsd,
});
export type ConsumerKindSpend = typeof ConsumerKindSpend.Type;

/** Money spent through one provider instance, priced from T3's own turns; for API-key billing. */
export const InstanceSpend = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  todayUsd: Schema.Number,
  /** Rolling last 30 days, including today. */
  periodUsd: Schema.Number,
  /** Some turns in the period had no usage or no known rate, so the totals are a floor. */
  partial: Schema.Boolean,
  budget: Schema.optionalKey(InstanceBudgetStatus),
  /** The heaviest consumers, by period spend; the rest count only in `consumerKinds`. */
  consumers: Schema.optionalKey(ForwardCompatibleArray(ConsumerSpend)),
  /** Every priced turn's spend, summed per consumer kind. */
  consumerKinds: Schema.optionalKey(ForwardCompatibleArray(ConsumerKindSpend)),
});
export const InstanceSpendResult = Schema.Struct({ instances: Schema.Array(InstanceSpend) });
export type InstanceSpendResult = typeof InstanceSpendResult.Type;
