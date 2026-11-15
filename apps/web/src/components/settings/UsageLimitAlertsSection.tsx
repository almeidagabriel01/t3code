import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitAlertThreshold,
} from "@t3tools/contracts";
import {
  usageLimitAlertChoices,
  usageLimitAlertLabel,
  usageLimitAlertOverride,
  usageLimitAlertRows,
  usageLimitAlertsPaused,
} from "@t3tools/shared/usageLimitAlerts";
import { Link } from "@tanstack/react-router";
import { CirclePauseIcon } from "lucide-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const OFF = "off";

const choiceLabel = (value: string) => (
  <span className="tabular-nums">{usageLimitAlertLabel(value === OFF ? null : Number(value))}</span>
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
                  <SelectItem value={OFF}>{choiceLabel(OFF)}</SelectItem>
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

/** One note above the provider cards while paused Autonomy holds back an alert that is on. */
export function UsageLimitAlertsPausedNotice({
  environmentId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const supported = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.usageLimitAlerts === true,
  );
  if (
    !supported ||
    settings === null ||
    !usageLimitAlertsPaused({
      autonomyEnabled: settings.autonomy.enabled,
      alerts: settings.usageLimitAlerts,
      providers,
    })
  ) {
    return null;
  }
  return (
    <Alert variant="warning">
      <CirclePauseIcon aria-hidden />
      <AlertTitle>Alerts are paused</AlertTitle>
      <AlertDescription>
        <p>
          Assistant notifications are off, so limit alerts wait. Change it in{" "}
          <Link
            to="/settings/assistants"
            className="cursor-pointer rounded-sm underline outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            Assistants
          </Link>
          .
        </p>
      </AlertDescription>
    </Alert>
  );
}
