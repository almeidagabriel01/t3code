import type {
  UsageLimitAlertConfig,
  UsageLimitAlertConfigPatch,
  UsageLimitAlerts,
} from "@t3tools/contracts";

/** Factory defaults by driver and window id; every other window starts off. */
const DEFAULT_THRESHOLDS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  claudeAgent: { seven_day: 15 },
};

/** Remaining percent that triggers the alert for a window, or null when it is off. */
export function usageLimitAlertThreshold(input: {
  readonly driver: string;
  readonly windowId: string;
  readonly config: UsageLimitAlertConfig | undefined;
}): number | null {
  const stored = input.config?.windows[input.windowId];
  if (stored === "off") return null;
  if (typeof stored === "number") return stored;
  return DEFAULT_THRESHOLDS[input.driver]?.[input.windowId] ?? null;
}

/** Window ids that alert by default for a driver, so they count before a first reading. */
export function defaultUsageLimitAlertWindows(driver: string): ReadonlyArray<string> {
  return Object.keys(DEFAULT_THRESHOLDS[driver] ?? {});
}

/** Per-window merge; an instance left with no override and no zone is dropped. */
export function mergeUsageLimitAlerts(
  current: UsageLimitAlerts,
  patch: Readonly<Record<string, UsageLimitAlertConfigPatch | null>>,
): UsageLimitAlerts {
  const next: Record<string, UsageLimitAlertConfig | undefined> = { ...current };
  for (const [instanceId, entry] of Object.entries(patch)) {
    if (entry === null) {
      delete next[instanceId];
      continue;
    }
    const windows: Record<string, UsageLimitAlertConfig["windows"][string]> = {
      ...next[instanceId]?.windows,
    };
    for (const [windowId, threshold] of Object.entries(entry.windows ?? {})) {
      if (threshold === null) delete windows[windowId];
      else windows[windowId] = threshold;
    }
    const timeZone = entry.timeZone ?? next[instanceId]?.timeZone;
    if (Object.keys(windows).length === 0) delete next[instanceId];
    else next[instanceId] = { windows, ...(timeZone === undefined ? {} : { timeZone }) };
  }
  return next as UsageLimitAlerts;
}
