import type {
  ClientSettings,
  ClientSettingsPatch,
  StatusBarPortsCount,
  StatusBarPortsRefresh,
  StatusBarResourceSort,
  StatusBarUsageMode,
  StatusBarUsagePercentage,
  StatusBarUsageRefresh,
  UsageResetDisplay,
} from "@t3tools/contracts";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  isStatusBarItemShown,
  STATUS_BAR_KEEP_AWAKE_ITEM,
  STATUS_BAR_PORTS_ITEM,
  STATUS_BAR_RESOURCE_ITEM,
  STATUS_BAR_USAGE_ITEM,
  toggleStatusBarItem,
} from "../statusBar/statusBarItems.logic";
import { AccountPicker } from "../statusBar/AccountPicker";
import { useUsageItems } from "../statusBar/useUsageItems";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, settingCopy } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type StatusBarSettingsValues = Pick<
  ClientSettings,
  | "statusBarVisible"
  | "statusBarHiddenItems"
  | "statusBarUsageMode"
  | "statusBarUsagePercentage"
  | "statusBarPortsCount"
  | "statusBarResourceSort"
  | "statusBarUsageRefresh"
  | "statusBarPortsRefresh"
  | "usagePaceEnabled"
  | "statusBarUsagePaceVisible"
  | "usageProjectionEnabled"
  | "usageDailyBudgetEnabled"
  | "usageShowSessions"
  | "usageResetDisplay"
  | "usageWatchThreshold"
  | "usageCriticalThreshold"
>;

const USAGE_MODE_LABELS: Record<StatusBarUsageMode, string> = {
  verbose: "Verbose",
  compact: "Compact",
};
const USAGE_PERCENTAGE_LABELS: Record<StatusBarUsagePercentage, string> = {
  used: "Used",
  remaining: "Remaining",
};
const RESET_DISPLAY_LABELS: Record<UsageResetDisplay, string> = {
  day: "Day",
  countdown: "Countdown",
  both: "Day and countdown",
};
const PORTS_COUNT_LABELS: Record<StatusBarPortsCount, string> = {
  project: "Project ports",
  all: "All ports",
};
const USAGE_REFRESH_LABELS: Record<StatusBarUsageRefresh, string> = {
  "1m": "Every minute",
  "2m": "Every 2 minutes",
  "5m": "Every 5 minutes",
  "15m": "Every 15 minutes",
  "30m": "Every 30 minutes",
  manual: "Manual",
};
const PORTS_REFRESH_LABELS: Record<StatusBarPortsRefresh, string> = {
  "10s": "Every 10 seconds",
  "30s": "Every 30 seconds",
  "1m": "Every minute",
  "5m": "Every 5 minutes",
};
const RESOURCE_SORT_LABELS: Record<StatusBarResourceSort, string> = {
  memory: "Memory",
  cpu: "CPU",
  name: "Name",
};

function LabeledSelect<T extends string>({
  label,
  value,
  labels,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly labels: Record<T, string>;
  readonly onChange: (value: T) => void;
}) {
  const isOption = (candidate: string): candidate is T => Object.hasOwn(labels, candidate);
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null && isOption(next)) onChange(next);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={label}>
        <SelectValue>{labels[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {(Object.keys(labels) as T[]).map((option) => (
          <SelectItem hideIndicator key={option} value={option}>
            {labels[option]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ThresholdField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <NumberField
        value={value}
        min={min}
        max={max}
        step={5}
        size="sm"
        className="w-28"
        onValueChange={(next) => {
          if (next !== null && Number.isInteger(next)) onChange(next);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${label} threshold`} />
          <NumberFieldInput aria-label={`${label} threshold in percent`} />
          <NumberFieldIncrement aria-label={`Increase ${label} threshold`} />
        </NumberFieldGroup>
      </NumberField>
    </div>
  );
}

function ToggleRow({
  search,
  label,
  checked,
  onChange,
}: {
  readonly search: ReturnType<typeof searchableSetting>;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow
      {...search}
      control={
        <Switch
          checked={checked}
          onCheckedChange={(next) => onChange(Boolean(next))}
          aria-label={label}
        />
      }
    />
  );
}

function SegmentRow({
  search,
  id,
  label,
  settings,
  updateSettings,
}: {
  readonly search: ReturnType<typeof searchableSetting>;
  readonly id: string;
  readonly label: string;
  readonly settings: StatusBarSettingsValues;
  readonly updateSettings: (patch: ClientSettingsPatch) => void;
}) {
  return (
    <SettingsRow
      {...search}
      control={
        <Switch
          checked={isStatusBarItemShown(settings.statusBarHiddenItems, id)}
          onCheckedChange={() =>
            updateSettings({
              statusBarHiddenItems: toggleStatusBarItem(settings.statusBarHiddenItems, id),
            })
          }
          aria-label={label}
        />
      }
    />
  );
}

function StatusBarSettingsSections({
  settings,
  updateSettings,
}: {
  readonly settings: StatusBarSettingsValues;
  readonly updateSettings: (patch: ClientSettingsPatch) => void;
}) {
  const { items } = useUsageItems();
  const segment = { settings, updateSettings };

  return (
    <>
      <SettingsSection id="status-bar" title={settingCopy("status-bar-visible").title}>
        <SettingsRow
          {...searchableSetting("status-bar-visible")}
          control={
            <Switch
              checked={settings.statusBarVisible}
              onCheckedChange={(checked) => updateSettings({ statusBarVisible: Boolean(checked) })}
              aria-label="Status bar"
            />
          }
        />
        <SegmentRow
          {...segment}
          search={searchableSetting("status-bar-segment-usage")}
          id={STATUS_BAR_USAGE_ITEM}
          label="Usage"
        />
        <SegmentRow
          {...segment}
          search={searchableSetting("status-bar-segment-ports")}
          id={STATUS_BAR_PORTS_ITEM}
          label="Ports"
        />
        <SegmentRow
          {...segment}
          search={searchableSetting("status-bar-segment-resources")}
          id={STATUS_BAR_RESOURCE_ITEM}
          label="Resource usage"
        />
        <SegmentRow
          {...segment}
          search={searchableSetting("status-bar-segment-keep-awake")}
          id={STATUS_BAR_KEEP_AWAKE_ITEM}
          label="Keep awake"
        />
      </SettingsSection>

      <SettingsSection id="status-bar-usage" title={settingCopy("status-bar-section-usage").title}>
        <SettingsRow {...searchableSetting("status-bar-items")}>
          <div className="pt-2">
            <AccountPicker
              items={items}
              hidden={settings.statusBarHiddenItems}
              display={settings.statusBarUsagePercentage}
              onToggle={(id) =>
                updateSettings({
                  statusBarHiddenItems: toggleStatusBarItem(settings.statusBarHiddenItems, id),
                })
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          {...searchableSetting("status-bar-usage-refresh")}
          control={
            <LabeledSelect
              label="Refresh usage"
              value={settings.statusBarUsageRefresh}
              labels={USAGE_REFRESH_LABELS}
              onChange={(statusBarUsageRefresh) => updateSettings({ statusBarUsageRefresh })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("status-bar-usage-mode")}
          control={
            <LabeledSelect
              label="Usage display"
              value={settings.statusBarUsageMode}
              labels={USAGE_MODE_LABELS}
              onChange={(statusBarUsageMode) => updateSettings({ statusBarUsageMode })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("status-bar-usage-percentage")}
          control={
            <LabeledSelect
              label="Usage percentage"
              value={settings.statusBarUsagePercentage}
              labels={USAGE_PERCENTAGE_LABELS}
              onChange={(statusBarUsagePercentage) => updateSettings({ statusBarUsagePercentage })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("status-bar-usage-reset")}
          control={
            <RadioGroup
              aria-label="Reset shown as"
              value={settings.usageResetDisplay}
              onValueChange={(value) => {
                const next = (Object.keys(RESET_DISPLAY_LABELS) as UsageResetDisplay[]).find(
                  (key) => key === value,
                );
                if (next) updateSettings({ usageResetDisplay: next });
              }}
            >
              {(Object.keys(RESET_DISPLAY_LABELS) as UsageResetDisplay[]).map((key) => (
                <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Radio value={key} />
                  {RESET_DISPLAY_LABELS[key]}
                </label>
              ))}
            </RadioGroup>
          }
        />
        <ToggleRow
          search={searchableSetting("status-bar-usage-pace")}
          label="Usage pace"
          checked={settings.usagePaceEnabled}
          onChange={(usagePaceEnabled) => updateSettings({ usagePaceEnabled })}
        />
        {settings.usagePaceEnabled ? (
          <ToggleRow
            search={searchableSetting("status-bar-usage-pace-in-bar")}
            label="Pace in the status bar"
            checked={settings.statusBarUsagePaceVisible}
            onChange={(statusBarUsagePaceVisible) => updateSettings({ statusBarUsagePaceVisible })}
          />
        ) : null}
        <ToggleRow
          search={searchableSetting("status-bar-usage-projection")}
          label="Usage projection"
          checked={settings.usageProjectionEnabled}
          onChange={(usageProjectionEnabled) => updateSettings({ usageProjectionEnabled })}
        />
        <ToggleRow
          search={searchableSetting("status-bar-usage-daily-budget")}
          label="Daily budget"
          checked={settings.usageDailyBudgetEnabled}
          onChange={(usageDailyBudgetEnabled) => updateSettings({ usageDailyBudgetEnabled })}
        />
        <SettingsRow
          {...searchableSetting("status-bar-usage-thresholds")}
          control={
            <div className="flex flex-wrap items-center gap-3">
              <ThresholdField
                label="Watch"
                value={settings.usageWatchThreshold}
                min={1}
                max={settings.usageCriticalThreshold - 1}
                onChange={(usageWatchThreshold) => updateSettings({ usageWatchThreshold })}
              />
              <ThresholdField
                label="Critical"
                value={settings.usageCriticalThreshold}
                min={settings.usageWatchThreshold + 1}
                max={100}
                onChange={(usageCriticalThreshold) => updateSettings({ usageCriticalThreshold })}
              />
            </div>
          }
        />
        <ToggleRow
          search={searchableSetting("status-bar-usage-sessions")}
          label="Sessions per account"
          checked={settings.usageShowSessions}
          onChange={(usageShowSessions) => updateSettings({ usageShowSessions })}
        />
      </SettingsSection>

      <SettingsSection id="status-bar-ports" title={settingCopy("status-bar-section-ports").title}>
        <SettingsRow
          {...searchableSetting("status-bar-ports-refresh")}
          control={
            <LabeledSelect
              label="Refresh ports"
              value={settings.statusBarPortsRefresh}
              labels={PORTS_REFRESH_LABELS}
              onChange={(statusBarPortsRefresh) => updateSettings({ statusBarPortsRefresh })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("status-bar-ports-count")}
          control={
            <LabeledSelect
              label="Ports count"
              value={settings.statusBarPortsCount}
              labels={PORTS_COUNT_LABELS}
              onChange={(statusBarPortsCount) => updateSettings({ statusBarPortsCount })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="status-bar-resources"
        title={settingCopy("status-bar-section-resources").title}
      >
        <SettingsRow
          {...searchableSetting("status-bar-resource-sort")}
          control={
            <LabeledSelect
              label="Resource manager sort"
              value={settings.statusBarResourceSort}
              labels={RESOURCE_SORT_LABELS}
              onChange={(statusBarResourceSort) => updateSettings({ statusBarResourceSort })}
            />
          }
        />
      </SettingsSection>
    </>
  );
}

export function StatusBarSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsPageContainer>
      <StatusBarSettingsSections settings={settings} updateSettings={updateSettings} />
    </SettingsPageContainer>
  );
}
