import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { PortsSegment } from "./PortsSegment";
import { ResourceSegment } from "./ResourceSegment";
import { StatusBarVisibilityMenu, type StatusBarMenuPoint } from "./StatusBarVisibilityMenu";
import { UsageSegments } from "./UsageSegments";

export const STATUS_BAR_HEIGHT = "1.5rem";

export function StatusBar() {
  const visible = useClientSettings((settings) => settings.statusBarVisible);
  const [menuPoint, setMenuPoint] = useState<StatusBarMenuPoint>({ x: 0, y: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  if (!visible) return null;
  return (
    <>
      <footer
        className="relative flex h-(--status-bar-height) shrink-0 select-none items-center justify-between gap-4 overflow-clip border-t border-border bg-card px-3 text-xs whitespace-nowrap text-muted-foreground"
        data-slot="status-bar"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuPoint({ x: event.clientX, y: event.clientY });
          setMenuOpen(true);
        }}
      >
        <UsageSegments />
        <div className="flex shrink-0 items-center gap-3">
          <PortsSegment />
          <ResourceSegment />
        </div>
      </footer>
      <StatusBarVisibilityMenu
        point={menuPoint}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
    </>
  );
}
