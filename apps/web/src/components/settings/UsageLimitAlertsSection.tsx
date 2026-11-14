import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitAlertThreshold,
} from "@t3tools/contracts";
import {
  usageLimitAlertChoices,
  usageLimitAlertOverride,
  usageLimitAlertRows,
} from "@t3tools/shared/usageLimitAlerts";
import { Link } from "@tanstack/react-router";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const OFF = "off";

const choiceLabel = (value: string) => (
  <span className="tabular-nums">{value === OFF ? "Off" : `${value}% left`}</span>
);

export function UsageLimitAlertsSection({
  environmentId,
  instanceId,
  provider,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const supported = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.usageLimitAlerts === true,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  // Older servers drop the patch and never alert.
  if (!supported || provider === undefined) return null;
  const rows = usageLimitAlertRows({
    driver: provider.driver,
    windows: provider.usageLimits?.windows,
    config: settings?.usageLimitAlerts.instances[instanceId],
  });
  if (rows.length === 0) return null;
  const ignorePause = settings?.usageLimitAlerts.ignoreAutonomyPause ?? true;
  const save = (windowId: string, threshold: UsageLimitAlertThreshold) =>
    updateSettings({
      usageLimitAlerts: {
        instances: {
          // The zone of the client that saved it names the reset time in the message.
          [instanceId]: {
            windows: {
              [windowId]: usageLimitAlertOverride({ driver: provider.driver, windowId, threshold }),
            },
            timeZone: LOCAL_TIME_ZONE,
          },
        },
      },
    });

  return (
    <SettingsSection
      {...searchableSetting("usage-limit-alerts")}
      description="Your assistant messages you once when this much is left."
      inert={readOnly}
      aria-disabled={readOnly || undefined}
      className={readOnly ? "opacity-50 select-none" : undefined}
    >
      {rows.map((row) => {
        const value = row.threshold === null ? OFF : String(row.threshold);
        return (
          <SettingsRow
            key={row.windowId}
            title={row.label}
            control={
              <Select
                value={value}
                onValueChange={(next) => {
                  if (next === OFF) save(row.windowId, OFF);
                  else if (typeof next === "string" && Number.isInteger(Number(next))) {
                    save(row.windowId, Number(next));
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={`${row.label} limit alert`}>
                  <SelectValue>{choiceLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={OFF}>Off</SelectItem>
                  {usageLimitAlertChoices(row.threshold).map((choice) => (
                    <SelectItem key={choice} value={String(choice)}>
                      {choiceLabel(String(choice))}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        );
      })}
      {settings?.autonomy.enabled === false && !ignorePause ? (
        <SettingsRow
          title="Alerts are paused"
          description={
            <>
              Assistant notifications are off, so these alerts wait. Change it in{" "}
              <Link
                to="/settings/assistants"
                className="cursor-pointer rounded-sm underline outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                Assistants
              </Link>
              .
            </>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
