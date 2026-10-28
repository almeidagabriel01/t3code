import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_CLIENT_SETTINGS, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { pacePresentation, type UsagePaceSettings } from "@t3tools/shared/usagePace";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

const DEFAULTS = DEFAULT_CLIENT_SETTINGS;

/** The web client settings that shape usage, stored per device on mobile. */
export function useUsagePaceSettings(): UsagePaceSettings & { readonly showSessions: boolean } {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferences) ? preferences.value : {};
  return {
    pace: stored.usagePaceEnabled ?? DEFAULTS.usagePaceEnabled,
    projection: stored.usageProjectionEnabled ?? DEFAULTS.usageProjectionEnabled,
    dailyBudget: stored.usageDailyBudgetEnabled ?? DEFAULTS.usageDailyBudgetEnabled,
    showSessions: stored.usageShowSessions ?? DEFAULTS.usageShowSessions,
    watch: DEFAULTS.usageWatchThreshold,
    critical: DEFAULTS.usageCriticalThreshold,
  };
}

const formatAt = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** Mobile bars fill with what is left, matching the `remaining` display on web. */
export function PaceDetail(props: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly settings: UsagePaceSettings;
}) {
  const view = pacePresentation({
    window: props.window,
    now: props.now,
    display: "remaining",
    settings: props.settings,
    formatAt,
  });
  if (view === null) return null;
  return (
    <View className="gap-0.5">
      <Text
        className={
          view.deficit ? "text-xs text-danger-foreground" : "text-xs text-foreground-tertiary"
        }
      >
        {view.paceText}
      </Text>
      {view.projectionText ? (
        <Text className="text-xs text-foreground-tertiary">{view.projectionText}</Text>
      ) : null}
      {view.dailyText ? (
        <Text className="text-xs text-foreground-tertiary">{view.dailyText}</Text>
      ) : null}
    </View>
  );
}

export function UsagePaceSettingsSection() {
  const save = useAtomSet(updateMobilePreferencesAtom);
  const settings = useUsagePaceSettings();
  return (
    <SettingsSection title="Pace">
      <SettingsSwitchRow
        icon="timer"
        label="Expected pace"
        subtitle="Mark how much of the window has elapsed and show over or under pace."
        value={settings.pace}
        onValueChange={(value) => save({ usagePaceEnabled: value })}
      />
      <SettingsSwitchRow
        icon="target"
        label="Projection"
        subtitle="Estimate usage at reset, or when the limit runs out."
        value={settings.projection}
        onValueChange={(value) => save({ usageProjectionEnabled: value })}
      />
      <SettingsSwitchRow
        icon="calendar.badge.clock"
        label="Daily budget"
        subtitle="Show today's share of the weekly budget."
        value={settings.dailyBudget}
        onValueChange={(value) => save({ usageDailyBudgetEnabled: value })}
      />
      <SettingsSwitchRow
        icon="bolt.circle"
        label="Sessions"
        subtitle="List live threads per account, grouped by project."
        value={settings.showSessions}
        onValueChange={(value) => save({ usageShowSessions: value })}
      />
    </SettingsSection>
  );
}
