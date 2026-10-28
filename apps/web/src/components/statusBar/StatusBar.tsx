import { ResourceSegment } from "./ResourceSegment";
import { UsageSegments } from "./UsageSegments";

export const STATUS_BAR_HEIGHT = "1.5rem";

export function StatusBar() {
  return (
    <footer
      className="flex h-(--status-bar-height) shrink-0 items-center justify-between gap-2 overflow-hidden border-t border-border bg-background px-2 text-2xs text-muted-foreground"
      data-slot="status-bar"
    >
      <UsageSegments />
      <ResourceSegment />
    </footer>
  );
}
