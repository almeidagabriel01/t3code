import type { EnvironmentId, ServerConfig, ServerProviderUsageLimits } from "@t3tools/contracts";
import { limitsNotice, providerAccountKeys } from "@t3tools/shared/usageLimits";

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

/** API-key instances have no subscription limits; their cost is what matters. */
export const isApiKeyItem = (snapshot: ProviderInstanceEntry["snapshot"]) =>
  snapshot.auth.type === "apiKey";

export interface UsageItem {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  /** Every connected environment this account is signed in on. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
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
  const environmentsByKey = new Map<string, EnvironmentId[]>();

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
      if (
        !entry.enabled ||
        (limits === undefined &&
          !driversWithUsage.has(entry.driverKind) &&
          !isApiKeyItem(entry.snapshot))
      ) {
        continue;
      }
      const account = accountKeys.get(`${environmentId}:${entry.instanceId}`) ?? null;
      const key =
        account === null
          ? `${environmentId}:${entry.instanceId}`
          : `${account}|${entry.instanceId}`;
      environmentsByKey.set(key, [...(environmentsByKey.get(key) ?? []), environmentId]);
      labels.set(key, [...(labels.get(key) ?? []), presentation.entry.target.label]);
      if (items.has(key)) continue;
      items.set(key, {
        key,
        environmentId,
        environmentIds: [],
        entry,
        limits,
        showBadge: shouldShowInstanceBadge(entry, entries),
        environmentLabel: null,
      });
    }
  }
  return [...items].map(([key, item]) => ({
    ...item,
    environmentIds: environmentsByKey.get(key) ?? [],
    environmentLabel: labelEnvironments ? [...new Set(labels.get(key))].join(", ") : null,
  }));
}

/** Limits older than this, with nothing newer behind them, are shown as last known. */
export const STALE_AFTER_MS = 15 * 60_000;

export type LimitsStatus =
  | {
      readonly kind: "live" | "stale";
      readonly windows: ServerProviderUsageLimits["windows"];
      readonly checkedAt: string;
    }
  | { readonly kind: "none"; readonly message: string; readonly canRetry: boolean };

/** Last-known windows win over any notice; with none, say what actually happened. */
export function limitsStatus(item: Pick<UsageItem, "limits" | "entry">, now: number): LimitsStatus {
  const { limits, entry } = item;
  if (limits !== undefined && limits.windows.length > 0) {
    const stale =
      limits.unavailable !== undefined || now - Date.parse(limits.checkedAt) > STALE_AFTER_MS;
    return {
      kind: stale ? "stale" : "live",
      windows: limits.windows,
      checkedAt: limits.checkedAt,
    };
  }
  if (limits?.unavailable?.reason === "unsupported") {
    return { kind: "none", message: limitsNotice(limits) ?? "", canRetry: false };
  }
  return {
    kind: "none",
    message:
      limits?.unavailable?.message ??
      (limits === undefined ? entry.snapshot.message : undefined) ??
      `${entry.displayName} didn't report limits right now.`,
    canRetry: true,
  };
}
