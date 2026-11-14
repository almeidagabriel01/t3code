import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import type { ServerSettings } from "@t3tools/contracts";
import { usageLimitAlertChoices, usageLimitAlertRows } from "@t3tools/shared/usageLimitAlerts";

export interface UsageAlertSection {
  readonly instanceId: string;
  readonly title: string;
  readonly rows: ReturnType<typeof usageLimitAlertRows>;
}

/** Enabled provider instances that report at least one alertable window. */
export function usageAlertSections(
  providers: ReadonlyArray<ServerProvider>,
  alerts: ServerSettings["usageLimitAlerts"] | undefined,
): ReadonlyArray<UsageAlertSection> {
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      instanceId: provider.instanceId,
      title:
        provider.displayName?.trim() || PROVIDER_DISPLAY_NAMES[provider.driver] || provider.driver,
      rows: usageLimitAlertRows({
        driver: provider.driver,
        windows: provider.usageLimits?.windows,
        config: alerts?.[provider.instanceId],
      }),
    }))
    .filter((section) => section.rows.length > 0);
}

export const usageAlertValueLabel = (threshold: number | null) =>
  threshold === null ? "Off" : `${threshold}%`;

/** "Off" plus each percent; the chosen one is on. */
export function usageAlertMenuActions(threshold: number | null) {
  const state = (on: boolean) => (on ? ("on" as const) : ("off" as const));
  return [
    { id: "off", title: "Off", state: state(threshold === null) },
    ...usageLimitAlertChoices(threshold).map((choice) => ({
      id: String(choice),
      title: `${choice}%`,
      state: state(threshold === choice),
    })),
  ];
}

export function usageAlertPatch(input: {
  readonly instanceId: string;
  readonly windowId: string;
  readonly choiceId: string;
  readonly timeZone: string;
}) {
  const choice = input.choiceId === "off" ? ("off" as const) : Number(input.choiceId);
  if (choice !== "off" && !Number.isInteger(choice)) return null;
  return {
    usageLimitAlerts: {
      [input.instanceId]: { windows: { [input.windowId]: choice }, timeZone: input.timeZone },
    },
  };
}
