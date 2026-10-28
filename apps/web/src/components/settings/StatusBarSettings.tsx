import type {
  ClientSettings,
  ClientSettingsPatch,
  StatusBarPortsCount,
  StatusBarResourceSort,
  StatusBarUsageMode,
  StatusBarUsagePercentage,
} from "@t3tools/contracts";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  isStatusBarItemShown,
  STATUS_BAR_PORTS_ITEM,
  STATUS_BAR_RESOURCE_ITEM,
  STATUS_BAR_USAGE_ITEM,
  toggleStatusBarItem,
} from "../statusBar/statusBarItems.logic";
import { AccountPicker } from "../statusBar/AccountPicker";
import { useUsageItems } from "../statusBar/useUsageItems";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type StatusBarSettingsValues = Pick<
  ClientSettings,
  | "statusBarVisible"
  | "statusBarHiddenItems"
  | "statusBarUsageMode"
  | "statusBarUsagePercentage"
  | "statusBarPortsCount"
  | "statusBarResourceSort"
  | "usagePaceEnabled"
  | "statusBarUsagePaceVisible"
  | "usageProjectionEnabled"
  | "usageDailyBudgetEnabled"
  | "usageShowSessions"
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
const PORTS_COUNT_LABELS: Record<StatusBarPortsCount, string> = {
  project: "Project ports",
  all: "All ports",
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
  description,
  label,
  checked,
  onChange,
}: {
  readonly search: ReturnType<typeof searchableSetting>;
  readonly description: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow
      {...search}
      description={description}
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
  description,
  id,
  label,
  settings,
  updateSettings,
}: {
  readonly search: ReturnType<typeof searchableSetting>;
  readonly description: string;
  readonly id: string;
  readonly label: string;
  readonly settings: StatusBarSettingsValues;
  readonly updateSettings: (patch: ClientSettingsPatch) => void;
}) {
  return (
    <SettingsRow
      {...search}
      description={description}
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
      <SettingsSection id="status-bar" title="Status bar">
        <SettingsRow
          {...searchableSetting("status-bar-visible")}
          description="Show a bar along the bottom of the window. Right-click it to choose what it shows."
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
          description="Provider usage limits and reset countdowns."
        />
        <SegmentRow
          {...segment}
          search={searchableSetting("status-bar-segment-ports")}
          id={STATUS_BAR_PORTS_ITEM}
          label="Ports"
          description="Listening ports, with the processes that hold them."
        />
        <SegmentRow
          {...segment}
          search={searchableSetting("status-bar-segment-resources")}
          id={STATUS_BAR_RESOURCE_ITEM}
          label="Resource usage"
          description="Memory, CPU and running terminals."
        />
      </SettingsSection>

      <SettingsSection id="status-bar-usage" title="Usage">
        <SettingsRow
          {...searchableSetting("status-bar-items")}
          description="Choose which accounts the usage segment shows. New accounts show by default."
        >
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
          {...searchableSetting("status-bar-usage-mode")}
          description="Verbose shows a meter with each limit window. Compact shows only the tightest one."
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
          description="Show how much of each limit is used, or how much is left."
          control={
            <LabeledSelect
              label="Usage percentage"
              value={settings.statusBarUsagePercentage}
              labels={USAGE_PERCENTAGE_LABELS}
              onChange={(statusBarUsagePercentage) => updateSettings({ statusBarUsagePercentage })}
            />
          }
        />
        <ToggleRow
          search={searchableSetting("status-bar-usage-pace")}
          label="Usage pace"
          description="Mark where even spending would be on each limit, and show how far ahead or behind you are."
          checked={settings.usagePaceEnabled}
          onChange={(usagePaceEnabled) => updateSettings({ usagePaceEnabled })}
        />
        {settings.usagePaceEnabled ? (
          <ToggleRow
            search={searchableSetting("status-bar-usage-pace-in-bar")}
            label="Pace in the status bar"
            description="Also show the pace marker and how far over or under pace you are in the bar itself. Off keeps it in the usage popover only."
            checked={settings.statusBarUsagePaceVisible}
            onChange={(statusBarUsagePaceVisible) => updateSettings({ statusBarUsagePaceVisible })}
          />
        ) : null}
        <ToggleRow
          search={searchableSetting("status-bar-usage-projection")}
          label="Usage projection"
          description="Project where each limit lands at reset, or when it runs out, once a fifteenth of the window has passed."
          checked={settings.usageProjectionEnabled}
          onChange={(usageProjectionEnabled) => updateSettings({ usageProjectionEnabled })}
        />
        <ToggleRow
          search={searchableSetting("status-bar-usage-daily-budget")}
          label="Daily budget"
          description="For weekly limits, show how much of the budget allowed through today you have used."
          checked={settings.usageDailyBudgetEnabled}
          onChange={(usageDailyBudgetEnabled) => updateSettings({ usageDailyBudgetEnabled })}
        />
        <SettingsRow
          {...searchableSetting("status-bar-usage-thresholds")}
          description="Bars turn amber past the watch level and red past the critical level. Watch stays below critical."
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
          description="List the threads using each account in the usage popover."
          checked={settings.usageShowSessions}
          onChange={(usageShowSessions) => updateSettings({ usageShowSessions })}
        />
      </SettingsSection>

      <SettingsSection id="status-bar-ports" title="Ports">
        <SettingsRow
          {...searchableSetting("status-bar-ports-count")}
          description="What the ports count includes. The list always shows both."
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

      <SettingsSection id="status-bar-resources" title="Resource manager">
        <SettingsRow
          {...searchableSetting("status-bar-resource-sort")}
          description="How the resource manager orders projects and terminals when it opens."
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
