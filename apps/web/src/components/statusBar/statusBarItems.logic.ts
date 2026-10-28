import type { StatusBarUsagePercentage } from "@t3tools/contracts";

export const STATUS_BAR_PORTS_ITEM = "ports";
export const STATUS_BAR_RESOURCE_ITEM = "resource-usage";

/** Hidden ids are stored, so an instance added later shows by default. */
export const isStatusBarItemShown = (hidden: ReadonlyArray<string>, id: string): boolean =>
  !hidden.includes(id);

export const toggleStatusBarItem = (hidden: ReadonlyArray<string>, id: string): string[] =>
  hidden.includes(id) ? hidden.filter((item) => item !== id) : [...hidden, id];

export function displayedPercent(usedPercent: number, display: StatusBarUsagePercentage): number {
  const used = Math.min(100, Math.max(0, usedPercent));
  return Math.round(display === "remaining" ? 100 - used : used);
}
