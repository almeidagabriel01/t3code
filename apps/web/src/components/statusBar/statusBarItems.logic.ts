import type { ServerProviderUsageWindow, StatusBarUsagePercentage } from "@t3tools/contracts";

export const STATUS_BAR_USAGE_ITEM = "usage";
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

/** "22% · 0%" for the session and weekly windows, or every window when neither is reported. */
export function usagePreview(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  display: StatusBarUsagePercentage,
): string | null {
  const lead = windows.filter((window) => window.kind === "session" || window.kind === "weekly");
  const shown = lead.length > 0 ? lead : windows;
  return shown.length === 0
    ? null
    : shown.map((window) => `${displayedPercent(window.usedPercent, display)}%`).join(" · ");
}
