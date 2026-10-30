import { ChevronDownIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import {
  isDefaultQuickButtons,
  resetQuickButtons,
  RightPanelQuickButtonsCustomizer,
} from "../chat/RightPanelQuickButtonsCustomizer";
import { savedQuickButtons } from "../chat/rightPanelQuickButtons.logic";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function PanelShortcutsRow() {
  const saved = useClientSettings((settings) => settings.rightPanelQuickButtons);
  const count = savedQuickButtons(saved).length;
  return (
    <SettingsRow
      {...searchableSetting("right-panel-quick-buttons")}
      description="Choose which quick buttons appear under the right panel's tabs, and their order. You can also right-click the buttons."
      resetAction={
        isDefaultQuickButtons(saved) ? null : (
          <SettingResetButton label="panel shortcuts" onClick={resetQuickButtons} />
        )
      }
      control={
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between sm:w-40"
                aria-label={`Panel shortcuts: ${count} shown`}
              />
            }
          >
            {count} shown
            <ChevronDownIcon aria-hidden />
          </PopoverTrigger>
          <PopoverPopup align="end" padding="compact" width="sm" aria-label="Panel shortcuts">
            <RightPanelQuickButtonsCustomizer />
          </PopoverPopup>
        </Popover>
      }
    />
  );
}
