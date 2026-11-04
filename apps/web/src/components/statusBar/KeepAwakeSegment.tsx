import { useNavigate } from "@tanstack/react-router";
import { KEEP_AWAKE_MODES, type KeepAwakeMode } from "@t3tools/contracts";
import { CoffeeIcon, SettingsIcon } from "lucide-react";

import {
  useClientSettings,
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useKeepAwakeStatus } from "../../state/keepAwake";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isStatusBarItemShown, STATUS_BAR_KEEP_AWAKE_ITEM } from "./statusBarItems.logic";

const MODE_LABELS: Record<KeepAwakeMode, string> = {
  off: "Off",
  "while-working": "While agents are working",
  always: "Always",
};

/** The tooltip says what the host is doing now, not just what was chosen. */
function keepAwakeSummary(mode: KeepAwakeMode, active: boolean): string {
  if (active) return "Keeping this computer awake";
  return mode === "off" ? "This computer can sleep" : "Keeps this computer awake while agents work";
}

function KeepAwakeSegmentBody() {
  const navigate = useNavigate();
  const status = useKeepAwakeStatus(usePrimaryEnvironmentId());
  const mode = usePrimarySettings((settings) => settings.keepAwake);
  const canWrite = usePrimarySettingsAvailable();
  const updateSettings = useUpdatePrimarySettings();
  if (status?.supported !== true) return null;
  const summary = keepAwakeSummary(mode, status.active);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="icon-micro"
                  variant={status.active ? "ghost" : "ghost-muted"}
                  aria-label={summary}
                  data-active={status.active ? "" : undefined}
                />
              }
            />
          }
        >
          <CoffeeIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">{summary}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="end">
        <MenuGroup>
          <MenuGroupLabel>Keep this computer awake</MenuGroupLabel>
          <MenuRadioGroup
            value={mode}
            onValueChange={(value) => {
              const next = KEEP_AWAKE_MODES.find((candidate) => candidate === value);
              if (next !== undefined) updateSettings({ keepAwake: next });
            }}
          >
            {KEEP_AWAKE_MODES.map((option) => (
              <MenuRadioItem key={option} value={option} disabled={!canWrite} closeOnClick>
                {MODE_LABELS[option]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() => void navigate({ to: "/settings/maintenance", hash: "keep-awake" })}
        >
          <SettingsIcon />
          Keep-awake settings
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Always present on a host that can stay awake; lit while it really is being held awake. */
export function KeepAwakeSegment() {
  const hidden = useClientSettings((settings) => settings.statusBarHiddenItems);
  return isStatusBarItemShown(hidden, STATUS_BAR_KEEP_AWAKE_ITEM) ? <KeepAwakeSegmentBody /> : null;
}
