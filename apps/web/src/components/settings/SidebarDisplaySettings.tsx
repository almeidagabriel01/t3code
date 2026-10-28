import {
  PROJECT_HOVER_CARD_PROPERTIES,
  type ClientSettings,
  type ClientSettingsPatch,
  type ProjectHoverCardProperty,
  type SidebarAgentActivityDisplayMode,
} from "@t3tools/contracts";

import { toggleHoverCardProperty } from "../sidebar/sidebarDisplay.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type SidebarDisplayValues = Pick<
  ClientSettings,
  "sidebarShowSubagents" | "sidebarAgentActivityDisplayMode" | "projectHoverCardProperties"
>;

const ACTIVITY_MODE_LABELS: Record<SidebarAgentActivityDisplayMode, string> = {
  compact: "Compact",
  full: "Full",
};
const HOVER_PROPERTY_LABELS: Record<ProjectHoverCardProperty, string> = {
  path: "Project path",
  terminals: "Running terminals",
  resources: "Resource usage",
  ports: "Live ports",
};

export function SidebarDisplaySettingsRows({
  settings,
  updateSettings,
}: {
  readonly settings: SidebarDisplayValues;
  readonly updateSettings: (patch: ClientSettingsPatch) => void;
}) {
  return (
    <>
      <SettingsRow
        {...searchableSetting("sidebar-show-subagents")}
        description="List a thread's active subagents under it in the sidebar."
        control={
          <Switch
            checked={settings.sidebarShowSubagents}
            onCheckedChange={(checked) =>
              updateSettings({ sidebarShowSubagents: Boolean(checked) })
            }
            aria-label="Show subagents"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("sidebar-agent-activity")}
        description="Compact folds several subagents into one summary row. Full lists every one."
        control={
          <Select
            value={settings.sidebarAgentActivityDisplayMode}
            onValueChange={(value) => {
              if (value === "compact" || value === "full") {
                updateSettings({ sidebarAgentActivityDisplayMode: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Agent activity">
              <SelectValue>
                {ACTIVITY_MODE_LABELS[settings.sidebarAgentActivityDisplayMode]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(ACTIVITY_MODE_LABELS) as SidebarAgentActivityDisplayMode[]).map(
                (mode) => (
                  <SelectItem hideIndicator key={mode} value={mode}>
                    {ACTIVITY_MODE_LABELS[mode]}
                  </SelectItem>
                ),
              )}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("project-hover-card")}
        description="Choose what the card shows when you hover a project. Turn everything off to disable the card."
      >
        <div className="flex flex-col gap-2 pt-2">
          {PROJECT_HOVER_CARD_PROPERTIES.map((property) => (
            <label key={property} className="flex items-center justify-between gap-3 text-sm">
              <span>{HOVER_PROPERTY_LABELS[property]}</span>
              <Switch
                checked={settings.projectHoverCardProperties.includes(property)}
                onCheckedChange={(checked) =>
                  updateSettings({
                    projectHoverCardProperties: toggleHoverCardProperty(
                      settings.projectHoverCardProperties,
                      property,
                      Boolean(checked),
                    ),
                  })
                }
                aria-label={HOVER_PROPERTY_LABELS[property]}
              />
            </label>
          ))}
        </div>
      </SettingsRow>
    </>
  );
}
