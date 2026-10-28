import type { EnvironmentId, ServerConfig, ServerProviderUsageLimits } from "@t3tools/contracts";
import { providerAccountKeys } from "@t3tools/shared/usageLimits";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  shouldShowInstanceBadge,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";

export type UsagePresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: Pick<
      ServerConfig,
      "providers" | "settings" | "usageLimitSources"
    > | null;
  }
>;

export interface UsageItem {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly entry: ProviderInstanceEntry;
  /** Undefined when the instance reported nothing; it still shows, as unavailable. */
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly showBadge: boolean;
  /** Set only while more than one environment is connected. */
  readonly environmentLabel: string | null;
}

/**
 * One item per enabled instance whose driver reports usage, even when this instance reported
 * none. Two instances of one environment are always distinct; only the same instance id on the
 * same account across environments collapses into one item.
 */
export function collectUsageItems(presentations: UsagePresentations): ReadonlyArray<UsageItem> {
  const labelEnvironments = presentations.size > 1;
  const accountKeys = providerAccountKeys(presentations);
  const items = new Map<string, UsageItem>();
  const labels = new Map<string, string[]>();

  for (const [environmentId, presentation] of presentations) {
    const config = presentation.serverConfig;
    if (config === null) continue;
    const entries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(
        deriveProviderInstanceEntries(config.providers),
        config.settings,
        null,
      ),
    );
    const driversWithUsage = new Set(
      config.providers
        .filter((provider) => provider.usageLimits !== undefined)
        .map((provider) => provider.driver),
    );
    for (const entry of entries) {
      const limits = entry.snapshot.usageLimits;
      if (!entry.enabled || (limits === undefined && !driversWithUsage.has(entry.driverKind))) {
        continue;
      }
      const account = accountKeys.get(`${environmentId}:${entry.instanceId}`) ?? null;
      const key =
        account === null
          ? `${environmentId}:${entry.instanceId}`
          : `${account}|${entry.instanceId}`;
      labels.set(key, [...(labels.get(key) ?? []), presentation.entry.target.label]);
      if (items.has(key)) continue;
      items.set(key, {
        key,
        environmentId,
        entry,
        limits,
        showBadge: shouldShowInstanceBadge(entry, entries),
        environmentLabel: null,
      });
    }
  }
  return [...items].map(([key, item]) => ({
    ...item,
    environmentLabel: labelEnvironments ? [...new Set(labels.get(key))].join(", ") : null,
  }));
}
