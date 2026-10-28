import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
import type { InstanceBudgetStatus } from "@t3tools/contracts";
import type { UsageItem } from "./usageItems.logic";

export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
export const formatUsd = (value: number) => usd.format(value);

/** Spend of an API-key item; use only inside components rendered for such items. */
export function useInstanceSpend(item: UsageItem) {
  const result = useAtomValue(
    serverEnvironment.instanceSpend({
      environmentId: item.environmentId,
      input: { timeZone: TIME_ZONE },
    }),
  );
  const spend = Option.getOrNull(AsyncResult.value(result));
  return (
    spend?.instances.find((row) => row.providerInstanceId === item.entry.instanceId) ?? {
      todayUsd: 0,
      periodUsd: 0,
      partial: false,
      budget: undefined as InstanceBudgetStatus | undefined,
    }
  );
}
