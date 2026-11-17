import {
  MAX_PROVIDER_IDLE_TIMEOUT_MINUTES,
  MAX_TOOL_OUTPUT_HISTORY_DAYS,
  MIN_PROVIDER_IDLE_TIMEOUT_MINUTES,
  MIN_TOOL_OUTPUT_HISTORY_DAYS,
  SUGGESTED_TOOL_OUTPUT_HISTORY_DAYS,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { NumberField } from "../../../components/ui/NumberField";
import { IDLE_AGENTS_COPY, TOOL_OUTPUT_HISTORY_COPY } from "./maintenanceSectionsCopy";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

function NumberRow(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
      <View className="w-[22px] android:w-6" />
      <Text className="flex-1 text-foreground text-lg android:text-base">{props.label}</Text>
      {props.children}
    </View>
  );
}

/** Tool output history retention, shown with the storage settings. */
export function ToolOutputHistorySection(props: {
  readonly days: number | null;
  readonly disabled: boolean;
  readonly onChange: (days: number | null) => void;
}) {
  return (
    <SettingsSection
      title={TOOL_OUTPUT_HISTORY_COPY.title}
      footer={TOOL_OUTPUT_HISTORY_COPY.description}
    >
      <SettingsSwitchRow
        icon="clock"
        label={TOOL_OUTPUT_HISTORY_COPY.summarize}
        value={props.days !== null}
        disabled={props.disabled}
        onValueChange={(value) => props.onChange(value ? SUGGESTED_TOOL_OUTPUT_HISTORY_DAYS : null)}
      />
      {props.days !== null ? (
        <NumberRow label={TOOL_OUTPUT_HISTORY_COPY.daysToKeep}>
          <NumberField
            value={props.days}
            disabled={props.disabled}
            min={MIN_TOOL_OUTPUT_HISTORY_DAYS}
            max={MAX_TOOL_OUTPUT_HISTORY_DAYS}
            label={TOOL_OUTPUT_HISTORY_COPY.daysSheet}
            formatValue={(value) => `${value} ${value === 1 ? "day" : "days"}`}
            onValueChange={props.onChange}
          />
        </NumberRow>
      ) : null}
    </SettingsSection>
  );
}

export function ProviderIdleTimeoutSection(props: {
  readonly minutes: number;
  readonly disabled: boolean;
  readonly onChange: (minutes: number) => void;
}) {
  return (
    <SettingsSection title={IDLE_AGENTS_COPY.title} footer={IDLE_AGENTS_COPY.description}>
      <NumberRow label={IDLE_AGENTS_COPY.minutes}>
        <NumberField
          value={props.minutes}
          disabled={props.disabled}
          min={MIN_PROVIDER_IDLE_TIMEOUT_MINUTES}
          max={MAX_PROVIDER_IDLE_TIMEOUT_MINUTES}
          label={IDLE_AGENTS_COPY.minutesSheet}
          formatValue={(value) => `${value} min`}
          onValueChange={props.onChange}
        />
      </NumberRow>
    </SettingsSection>
  );
}
