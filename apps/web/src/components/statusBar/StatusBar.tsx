import { PortsSegment } from "./PortsSegment";
import { ResourceSegment } from "./ResourceSegment";
import { UsageSegments } from "./UsageSegments";

export const STATUS_BAR_HEIGHT = "1.5rem";

export function StatusBar() {
  return (
    <footer
      className="relative flex h-(--status-bar-height) shrink-0 select-none items-center justify-between gap-4 overflow-clip border-t border-border bg-card px-3 text-xs whitespace-nowrap text-muted-foreground"
      data-slot="status-bar"
    >
      <UsageSegments />
      <div className="flex shrink-0 items-center gap-3">
        <PortsSegment />
        <ResourceSegment />
      </div>
    </footer>
  );
}
