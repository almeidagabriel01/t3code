import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function MenuBarSettingsRow({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow
      {...searchableSetting("show-in-menu-bar")}
      description="List threads that need you, running threads and pinned threads in the macOS menu bar."
      resetAction={
        checked !== DEFAULT_UNIFIED_SETTINGS.showInMenuBar ? (
          <SettingResetButton
            label="menu bar icon"
            onClick={() => onChange(DEFAULT_UNIFIED_SETTINGS.showInMenuBar)}
          />
        ) : null
      }
      control={
        <Switch
          checked={checked}
          onCheckedChange={(next) => onChange(Boolean(next))}
          aria-label="Show in menu bar"
        />
      }
    />
  );
}
