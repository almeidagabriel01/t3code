import type {
  ClientSettings,
  ClientSettingsPatch,
  StatusBarPortsCount,
  StatusBarResourceSort,
  StatusBarUsageMode,
  StatusBarUsagePercentage,
} from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  isStatusBarItemShown,
  STATUS_BAR_PORTS_ITEM,
  STATUS_BAR_RESOURCE_ITEM,
  toggleStatusBarItem,
} from "../statusBar/statusBarItems.logic";
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

function StatusBarSettingsSection({
  settings,
  updateSettings,
}: {
  readonly settings: StatusBarSettingsValues;
  readonly updateSettings: (patch: ClientSettingsPatch) => void;
}) {
  const { items } = useUsageItems();
  const toggleItem = (id: string) =>
    updateSettings({
      statusBarHiddenItems: toggleStatusBarItem(settings.statusBarHiddenItems, id),
    });
  const itemSwitches = [
    ...items.map((item) => ({
      id: item.entry.instanceId as string,
      label: `${item.entry.displayName}${item.environmentLabel === null ? "" : ` · ${item.environmentLabel}`}`,
    })),
    { id: STATUS_BAR_RESOURCE_ITEM, label: "Resource usage" },
    { id: STATUS_BAR_PORTS_ITEM, label: "Ports" },
  ];

  return (
    <SettingsSection id="status-bar" title="Status bar">
      <SettingsRow
        {...searchableSetting("status-bar-visible")}
        description="Show usage, ports and resources along the bottom of the window. Right-click the bar to choose its items."
        control={
          <Switch
            checked={settings.statusBarVisible}
            onCheckedChange={(checked) => updateSettings({ statusBarVisible: Boolean(checked) })}
            aria-label="Status bar"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("status-bar-items")}
        description="Choose which indicators the bar shows. New providers show by default."
      >
        <div className="flex flex-col gap-2 pt-2">
          {itemSwitches.map(({ id, label }) => (
            <label key={id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{label}</span>
              <Switch
                checked={isStatusBarItemShown(settings.statusBarHiddenItems, id)}
                onCheckedChange={() => toggleItem(id)}
                aria-label={label}
              />
            </label>
          ))}
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
  );
}

export function StatusBarSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsPageContainer>
      <StatusBarSettingsSection settings={settings} updateSettings={updateSettings} />
    </SettingsPageContainer>
  );
}
