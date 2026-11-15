import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import type { ServerSettings } from "@t3tools/contracts";
import {
  usageLimitAlertChoices,
  usageLimitAlertLabel,
  usageLimitAlertOverride,
  usageLimitAlertRows,
} from "@t3tools/shared/usageLimitAlerts";

export interface UsageAlertSection {
  readonly instanceId: string;
  readonly driver: string;
  readonly title: string;
  readonly rows: ReturnType<typeof usageLimitAlertRows>;
}

/** Provider instances with at least one alertable window; disabled ones stay editable, as on the web. */
export function usageAlertSections(
  providers: ReadonlyArray<ServerProvider>,
  alerts: ServerSettings["usageLimitAlerts"]["instances"] | undefined,
): ReadonlyArray<UsageAlertSection> {
  return providers
    .map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
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

/** "Off" plus each percent; the chosen one is on. */
export function usageAlertMenuActions(threshold: number | null) {
  const state = (on: boolean) => (on ? ("on" as const) : ("off" as const));
  return [
    { id: "off", title: usageLimitAlertLabel(null), state: state(threshold === null) },
    ...usageLimitAlertChoices(threshold).map((choice) => ({
      id: String(choice),
      title: usageLimitAlertLabel(choice),
      state: state(threshold === choice),
    })),
  ];
}

export function usageAlertPatch(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly windowId: string;
  readonly choiceId: string;
  readonly timeZone: string;
}) {
  const choice = input.choiceId === "off" ? ("off" as const) : Number(input.choiceId);
  if (choice !== "off" && !Number.isInteger(choice)) return null;
  return {
    usageLimitAlerts: {
      instances: {
        [input.instanceId]: {
          windows: {
            [input.windowId]: usageLimitAlertOverride({
              driver: input.driver,
              windowId: input.windowId,
              threshold: choice,
            }),
          },
          timeZone: input.timeZone,
        },
      },
    },
  };
}
