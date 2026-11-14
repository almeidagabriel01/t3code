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
    config: settings?.usageLimitAlerts?.[instanceId],
  });
  if (rows.length === 0) return null;
  const save = (windowId: string, threshold: UsageLimitAlertThreshold) =>
    updateSettings({
      usageLimitAlerts: {
        // The zone of the client that saved it names the reset time in the message.
        [instanceId]: {
          windows: {
            [windowId]: usageLimitAlertOverride({ driver: provider.driver, windowId, threshold }),
          },
          timeZone: LOCAL_TIME_ZONE,
        },
      },
    });

  return (
    <SettingsSection
      {...searchableSetting("usage-limit-alerts")}
      inert={readOnly}
      aria-disabled={readOnly || undefined}
      className={readOnly ? "opacity-50 select-none" : undefined}
    >
      {settings?.autonomy.enabled === false ? (
        <SettingsRow
          title="Alerts are paused"
          description={
            <>
              They reach you through your assistant, and assistant notifications are off.{" "}
              <Link
                to="/settings/assistants"
                className="cursor-pointer rounded-sm underline outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                Turn on Autonomy
              </Link>
            </>
          }
        />
      ) : null}
      {rows.map((row) => {
        const value = row.threshold === null ? OFF : String(row.threshold);
        return (
          <SettingsRow
            key={row.windowId}
            title={row.label}
            description="Your assistant messages you once when this much is left."
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
    </SettingsSection>
  );
}
