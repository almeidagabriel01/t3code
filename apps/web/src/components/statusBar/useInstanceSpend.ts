import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
import type { InstanceSpendResult } from "@t3tools/contracts";
import type { UsageItem } from "./usageItems.logic";

export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
export const formatUsd = (value: number) => usd.format(value);

/** What T3's own turns on the item's instance cost, priced at API rates. */
export function useInstanceSpend(item: UsageItem): InstanceSpendResult["instances"][number] {
  const result = useAtomValue(
    serverEnvironment.instanceSpend({
      environmentId: item.environmentId,
      input: { timeZone: TIME_ZONE },
    }),
  );
  const spend = Option.getOrNull(AsyncResult.value(result));
  return (
    spend?.instances.find((row) => row.providerInstanceId === item.entry.instanceId) ?? {
      providerInstanceId: item.entry.instanceId,
      todayUsd: 0,
      periodUsd: 0,
      partial: false,
    }
  );
}
