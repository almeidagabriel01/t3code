import {
  USAGE_LIMIT_ALERT_CHOICES,
  type ServerProviderUsageWindow,
  type UsageLimitAlertConfig,
  type UsageLimitAlerts,
  type UsageLimitAlertsPatch,
  type UsageLimitAlertThreshold,
} from "@t3tools/contracts";

/** Factory defaults by driver and window id; every other window starts off. */
const DEFAULT_THRESHOLDS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  claudeAgent: { seven_day: 15 },
};
/** Labels for default windows an instance has not reported yet. */
const DEFAULT_WINDOW_LABELS: Readonly<Record<string, string>> = { seven_day: "Weekly" };

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

/** What a pick stores: the window's default clears the override, so a later default applies. */
export function usageLimitAlertOverride(input: {
  readonly driver: string;
  readonly windowId: string;
  readonly threshold: UsageLimitAlertThreshold;
}): UsageLimitAlertThreshold | null {
  const fallback = DEFAULT_THRESHOLDS[input.driver]?.[input.windowId] ?? "off";
  return input.threshold === fallback ? null : input.threshold;
}

/** Per-window merge; an instance left with no override and no zone is dropped. */
export function mergeUsageLimitAlerts(
  current: UsageLimitAlerts,
  patch: UsageLimitAlertsPatch,
): UsageLimitAlerts {
  const instances: Record<string, UsageLimitAlertConfig> = { ...current.instances };
  for (const [instanceId, entry] of Object.entries(patch.instances ?? {})) {
    if (entry === null) {
      delete instances[instanceId];
      continue;
    }
    const windows: Record<string, UsageLimitAlertConfig["windows"][string]> = {
      ...instances[instanceId]?.windows,
    };
    for (const [windowId, threshold] of Object.entries(entry.windows ?? {})) {
      if (threshold === null) delete windows[windowId];
      else windows[windowId] = threshold;
    }
    const timeZone = entry.timeZone ?? instances[instanceId]?.timeZone;
    if (Object.keys(windows).length === 0 && timeZone === undefined) delete instances[instanceId];
    else instances[instanceId] = { windows, ...(timeZone === undefined ? {} : { timeZone }) };
  }
  return {
    ignoreAutonomyPause: patch.ignoreAutonomyPause ?? current.ignoreAutonomyPause,
    instances: instances as UsageLimitAlerts["instances"],
  };
}

export interface UsageLimitAlertRow {
  readonly windowId: string;
  readonly label: string;
  /** Effective threshold, default included; null when off. */
  readonly threshold: number | null;
}

/** One row per reported window, plus default windows not reported yet, in the provider's order. */
export function usageLimitAlertRows(input: {
  readonly driver: string;
  readonly windows: ReadonlyArray<Pick<ServerProviderUsageWindow, "id" | "label">> | undefined;
  readonly config: UsageLimitAlertConfig | undefined;
}): ReadonlyArray<UsageLimitAlertRow> {
  const windows = [...(input.windows ?? [])];
  for (const windowId of defaultUsageLimitAlertWindows(input.driver)) {
    if (!windows.some((window) => window.id === windowId)) {
      windows.push({ id: windowId, label: DEFAULT_WINDOW_LABELS[windowId] ?? windowId });
    }
  }
  return windows.map((window) => ({
    windowId: window.id,
    label: window.label,
    threshold: usageLimitAlertThreshold({
      driver: input.driver,
      windowId: window.id,
      config: input.config,
    }),
  }));
}

/** The fixed choices, plus a saved value outside them so the picker can still show it. */
export function usageLimitAlertChoices(threshold: number | null): ReadonlyArray<number> {
  const choices: ReadonlyArray<number> = USAGE_LIMIT_ALERT_CHOICES;
  return threshold === null || choices.includes(threshold)
    ? choices
    : [...choices, threshold].sort((left, right) => left - right);
}
