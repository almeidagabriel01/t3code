import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { budgetPercent, budgetPeriodLabel } from "@t3tools/shared/providerBudget";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const FILL = { ok: "bg-foreground", warn: "bg-amber-500", exceeded: "bg-red-500" } as const;

function EnvironmentBudgets(props: {
  readonly environmentId: EnvironmentId;
  readonly names: Readonly<Record<string, string | undefined>>;
}) {
  const now = useNowMinuteMs();
  const result = useAtomValue(
    serverEnvironment.instanceSpend({
      environmentId: props.environmentId,
      input: { timeZone: TIME_ZONE },
    }),
  );
  const rows = (Option.getOrNull(AsyncResult.value(result))?.instances ?? []).flatMap((row) =>
    row.budget === undefined ? [] : [{ id: row.providerInstanceId, budget: row.budget }],
  );
  return rows.map(({ id, budget }) => {
    const percent = budgetPercent(budget);
    return (
      <View key={`${props.environmentId}:${id}`} className="gap-1">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text className="text-sm text-foreground">{props.names[id] ?? id}</Text>
          <Text className="text-sm tabular-nums text-foreground-muted">{percent}%</Text>
        </View>
        <View className="h-1.5 flex-row overflow-hidden rounded-full bg-subtle">
          <View
            className={`h-full rounded-full ${FILL[budget.state]}`}
            style={{ flex: Math.min(100, percent) }}
          />
          <View style={{ flex: Math.max(0, 100 - percent) }} />
        </View>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {usd.format(budget.spentUsd)} of {usd.format(budget.amountUsd)}{" "}
          {budgetPeriodLabel(budget, now)}
          {budget.blocking ? " · Blocking new turns" : ""}
        </Text>
      </View>
    );
  });
}

/** Read-only: budgets are edited in Settings on the desktop or web app. */
export function UsageBudgets({
  selectedEnvironmentIds,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const connected = [...presentations].filter(
    ([id, presentation]) =>
      presentation.connection.phase === "connected" &&
      (selectedEnvironmentIds === null || selectedEnvironmentIds.has(id)) &&
      Object.keys(presentation.serverConfig?.settings.providerBudgets ?? {}).length > 0,
  );
  if (connected.length === 0) return null;
  return (
    <View className="gap-3">
      <Text className="text-base font-t3-medium text-foreground">Spending budgets</Text>
      {connected.map(([environmentId, presentation]) => (
        <EnvironmentBudgets
          key={environmentId}
          environmentId={environmentId}
          names={Object.fromEntries(
            Object.entries(presentation.serverConfig?.settings.providerInstances ?? {}).map(
              ([id, instance]) => [id, instance.displayName],
            ),
          )}
        />
      ))}
    </View>
  );
}
