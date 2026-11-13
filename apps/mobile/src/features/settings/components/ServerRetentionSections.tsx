import {
  DEFAULT_SERVER_SETTINGS,
  MAX_PROVIDER_IDLE_TIMEOUT_MINUTES,
  MAX_TOOL_OUTPUT_HISTORY_DAYS,
  MIN_PROVIDER_IDLE_TIMEOUT_MINUTES,
  MIN_TOOL_OUTPUT_HISTORY_DAYS,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { NumberField } from "../../../components/ui/NumberField";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const HISTORY_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.toolOutputHistoryDays ?? 30;

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
      title="Tool output history"
      footer="Screenshots, file contents and command output in thread history are replaced by a short summary after this many days."
    >
      <SettingsSwitchRow
        icon="clock"
        label="Summarize old tool output"
        value={props.days !== null}
        disabled={props.disabled}
        onValueChange={(value) => props.onChange(value ? HISTORY_DEFAULT_DAYS : null)}
      />
      {props.days !== null ? (
        <NumberRow label="Days to keep">
          <NumberField
            value={props.days}
            disabled={props.disabled}
            min={MIN_TOOL_OUTPUT_HISTORY_DAYS}
            max={MAX_TOOL_OUTPUT_HISTORY_DAYS}
            label="Days to keep tool output"
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
    <SettingsSection
      title="Idle agents"
      footer="An idle Claude agent process is closed after this many minutes without activity. The conversation resumes on your next message."
    >
      <NumberRow label="Minutes before closing">
        <NumberField
          value={props.minutes}
          disabled={props.disabled}
          min={MIN_PROVIDER_IDLE_TIMEOUT_MINUTES}
          max={MAX_PROVIDER_IDLE_TIMEOUT_MINUTES}
          label="Minutes before an idle agent closes"
          formatValue={(value) => `${value} min`}
          onValueChange={props.onChange}
        />
      </NumberRow>
    </SettingsSection>
  );
}
