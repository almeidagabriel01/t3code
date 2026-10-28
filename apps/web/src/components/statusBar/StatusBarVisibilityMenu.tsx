import { useNavigate } from "@tanstack/react-router";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
import {
  isStatusBarItemShown,
  STATUS_BAR_PORTS_ITEM,
  STATUS_BAR_RESOURCE_ITEM,
  toggleStatusBarItem,
} from "./statusBarItems.logic";
import { useUsageItems } from "./useUsageItems";

export interface StatusBarMenuPoint {
  readonly x: number;
  readonly y: number;
}

function toggleStatusBarItemSetting(id: string) {
  return updateClientSettings({
    statusBarHiddenItems: toggleStatusBarItem(getClientSettings().statusBarHiddenItems, id),
  });
}

/** Right-click menu of the status bar, anchored at the cursor. */
export function StatusBarVisibilityMenu({
  point,
  open,
  onClose,
}: {
  readonly point: StatusBarMenuPoint;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const hidden = useClientSettings((settings) => settings.statusBarHiddenItems);
  const mode = useClientSettings((settings) => settings.statusBarUsageMode);
  const { items } = useUsageItems();
  const navigate = useNavigate();

  return (
    <Menu open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <MenuPopup
        side="top"
        align="start"
        sideOffset={0}
        anchor={{
          getBoundingClientRect: () =>
            DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }),
        }}
      >
        <div className="flex flex-col p-1">
          {items.map((item) => (
            <MenuCheckboxItem
              key={item.key}
              checked={isStatusBarItemShown(hidden, item.entry.instanceId)}
              onCheckedChange={() => void toggleStatusBarItemSetting(item.entry.instanceId)}
            >
              {item.entry.displayName}
              {item.environmentLabel === null ? "" : ` · ${item.environmentLabel}`}
            </MenuCheckboxItem>
          ))}
          <MenuCheckboxItem
            checked={isStatusBarItemShown(hidden, STATUS_BAR_RESOURCE_ITEM)}
            onCheckedChange={() => void toggleStatusBarItemSetting(STATUS_BAR_RESOURCE_ITEM)}
          >
            Resource usage
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={isStatusBarItemShown(hidden, STATUS_BAR_PORTS_ITEM)}
            onCheckedChange={() => void toggleStatusBarItemSetting(STATUS_BAR_PORTS_ITEM)}
          >
            Ports
          </MenuCheckboxItem>
          <MenuSeparator />
          <MenuRadioGroup
            value={mode}
            onValueChange={(value) =>
              void updateClientSettings({
                statusBarUsageMode: value === "compact" ? "compact" : "verbose",
              })
            }
          >
            <MenuRadioItem value="verbose">Verbose usage</MenuRadioItem>
            <MenuRadioItem value="compact">Compact usage</MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem onClick={() => void navigate({ to: "/settings/status-bar" })}>
            Status bar settings…
          </MenuItem>
          <MenuItem onClick={() => void updateClientSettings({ statusBarVisible: false })}>
            Hide status bar
          </MenuItem>
        </div>
      </MenuPopup>
    </Menu>
  );
}
