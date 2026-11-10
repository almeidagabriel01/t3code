import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ServerProviderUsageWindow,
  type UsageResetDisplay,
} from "@t3tools/contracts";
import { pacePresentation, type UsagePaceSettings } from "@t3tools/shared/usagePace";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

const DEFAULTS = DEFAULT_CLIENT_SETTINGS;

/** The web client settings that shape usage, stored per device on mobile. */
export function useUsagePaceSettings(): UsagePaceSettings & {
  readonly showSessions: boolean;
  readonly resetDisplay: UsageResetDisplay;
} {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferences) ? preferences.value : {};
  return {
    pace: stored.usagePaceEnabled ?? DEFAULTS.usagePaceEnabled,
    projection: stored.usageProjectionEnabled ?? DEFAULTS.usageProjectionEnabled,
    dailyBudget: stored.usageDailyBudgetEnabled ?? DEFAULTS.usageDailyBudgetEnabled,
    showSessions: stored.usageShowSessions ?? DEFAULTS.usageShowSessions,
    resetDisplay: stored.usageResetDisplay ?? DEFAULTS.usageResetDisplay,
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
      <Text className={`text-xs ${paceTone(view)}`}>{view.paceText}</Text>
      {view.projectionText ? (
        <Text className="text-xs text-foreground-tertiary">{view.projectionText}</Text>
      ) : null}
      {view.dailyText ? (
        <Text className="text-xs text-foreground-tertiary">{view.dailyText}</Text>
      ) : null}
    </View>
  );
}

export const RESET_DISPLAY_OPTIONS: ReadonlyArray<{
  readonly value: UsageResetDisplay;
  readonly label: string;
}> = [
  { value: "day", label: "Day" },
  { value: "countdown", label: "Countdown" },
  { value: "both", label: "Day and countdown" },
];

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

export function UsageResetSettingsSection() {
  const save = useAtomSet(updateMobilePreferencesAtom);
  const { resetDisplay } = useUsagePaceSettings();
  return (
    <>
      <SettingsSection title="Reset shown as">
        {RESET_DISPLAY_OPTIONS.map((option, index) => (
          <ListChoiceRow
            key={option.value}
            label={option.label}
            selected={resetDisplay === option.value}
            separated={index > 0}
            onPress={() => save({ usageResetDisplay: option.value })}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Weekly limits show the day they reset, or the time within 24 hours. The 5-hour session limit
        always shows its countdown.
      </Text>
    </>
  );
}

/** Over pace is red, under pace green, dead even neutral, matching web. */
export function paceTone(view: { readonly deficit: boolean; readonly reserve: boolean }) {
  return view.deficit
    ? "text-danger-foreground"
    : view.reserve
      ? "text-adaptive-emerald-600-400"
      : "text-foreground-tertiary";
}
