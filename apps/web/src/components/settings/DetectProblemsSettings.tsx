import {
  DETECT_PROBLEMS_DESCRIPTION,
  DETECT_PROBLEMS_IN_PROJECT_LABEL,
  DETECT_PROBLEMS_LABEL,
} from "@t3tools/client-runtime/autonomy";

import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function DetectProblemsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  return (
    <SettingsRow
      {...searchableSetting("detect-problems")}
      {...(isProjectScope
        ? { title: DETECT_PROBLEMS_IN_PROJECT_LABEL }
        : { description: DETECT_PROBLEMS_DESCRIPTION })}
      serverScoped
      settingKeys={["detectProblems"]}
      control={
        <ScopedSwitch
          settingKeys={["detectProblems"]}
          checked={settings.detectProblems}
          disabled={connectedEnvironments.length === 0}
          onCheckedChange={(checked) => updateSettings({ detectProblems: Boolean(checked) })}
          aria-label={isProjectScope ? DETECT_PROBLEMS_IN_PROJECT_LABEL : DETECT_PROBLEMS_LABEL}
        />
      }
    />
  );
}
