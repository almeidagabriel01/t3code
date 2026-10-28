import { useNavigate } from "@tanstack/react-router";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
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
  STATUS_BAR_USAGE_ITEM,
  toggleStatusBarItem,
} from "./statusBarItems.logic";
import { useUsageItems } from "./useUsageItems";

const SEGMENTS = [
  { id: STATUS_BAR_USAGE_ITEM, label: "Usage" },
  { id: STATUS_BAR_PORTS_ITEM, label: "Ports" },
  { id: STATUS_BAR_RESOURCE_ITEM, label: "Resource usage" },
] as const;

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
          <MenuGroup>
            <MenuGroupLabel>Segments</MenuGroupLabel>
            {SEGMENTS.map(({ id, label }) => (
              <MenuCheckboxItem
                key={id}
                checked={isStatusBarItemShown(hidden, id)}
                onCheckedChange={() => void toggleStatusBarItemSetting(id)}
              >
                {label}
              </MenuCheckboxItem>
            ))}
          </MenuGroup>
          {items.length === 0 ? null : (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Accounts</MenuGroupLabel>
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
              </MenuGroup>
            </>
          )}
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Usage display</MenuGroupLabel>
            <MenuRadioGroup
              value={mode}
              onValueChange={(value) =>
                void updateClientSettings({
                  statusBarUsageMode: value === "compact" ? "compact" : "verbose",
                })
              }
            >
              <MenuRadioItem value="verbose">Verbose</MenuRadioItem>
              <MenuRadioItem value="compact">Compact</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => void updateClientSettings({ statusBarVisible: false })}>
            Hide status bar
          </MenuItem>
          <MenuItem onClick={() => void navigate({ to: "/settings/status-bar" })}>
            Status bar settings…
          </MenuItem>
        </div>
      </MenuPopup>
    </Menu>
  );
}
