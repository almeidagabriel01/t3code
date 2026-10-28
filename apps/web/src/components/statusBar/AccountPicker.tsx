import type { StatusBarUsagePercentage } from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";

import { cn } from "../../lib/utils";
import { CheckboxMark } from "../ui/checkbox";
import { isStatusBarItemShown, usagePreview } from "./statusBarItems.logic";
import type { UsageItem } from "./usageItems.logic";
import { ItemIcon } from "./UsageSegments";

function accountSummary(item: UsageItem, display: StatusBarUsagePercentage): string {
  if (item.limits === undefined) return item.entry.snapshot.message ?? "No usage reported.";
  return (
    limitsNotice(item.limits) ?? usagePreview(item.limits.windows, display) ?? "No usage reported."
  );
}

/** One checkbox tile per provider instance; the tile is the button, so it is a single tab stop. */
export function AccountPicker({
  items,
  hidden,
  display,
  onToggle,
}: {
  readonly items: ReadonlyArray<UsageItem>;
  readonly hidden: ReadonlyArray<string>;
  readonly display: StatusBarUsagePercentage;
  readonly onToggle: (id: string) => void;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">No accounts report usage yet.</p>;
  }
  return (
    <div role="group" aria-label="Accounts" className="grid gap-2 sm:grid-cols-2">
      {items.map((item) => {
        const id = item.entry.instanceId;
        const checked = isStatusBarItemShown(hidden, id);
        const usable = item.limits !== undefined && limitsNotice(item.limits) === null;
        return (
          <button
            key={item.key}
            type="button"
            role="checkbox"
            aria-checked={checked}
            onClick={() => onToggle(id)}
            className={cn(
              "flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              checked ? "border-primary/40 bg-accent/40" : "border-border hover:bg-accent/30",
              !usable && "text-muted-foreground",
            )}
          >
            <CheckboxMark checked={checked} />
            <ItemIcon item={item} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">
                {item.entry.displayName}
                {item.environmentLabel === null ? null : (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {item.environmentLabel}
                  </span>
                )}
              </span>
              <span className="truncate text-xs tabular-nums text-muted-foreground">
                {accountSummary(item, display)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
