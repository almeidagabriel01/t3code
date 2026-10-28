import type {
  ClientSettings,
  ServerProviderUsageWindow,
  StatusBarUsagePercentage,
} from "@t3tools/contracts";
import {
  formatPaceDelta,
  projectedAtReset,
  usageBand,
  usagePace,
  type UsageBand,
} from "@t3tools/shared/usageLimits";

export const selectUsagePaceSettings = (settings: ClientSettings) => ({
  pace: settings.usagePaceEnabled,
  projection: settings.usageProjectionEnabled,
  dailyBudget: settings.usageDailyBudgetEnabled,
  watch: settings.usageWatchThreshold,
  critical: settings.usageCriticalThreshold,
});
export type UsagePaceSettings = ReturnType<typeof selectUsagePaceSettings>;

export const BAND_TEXT: Record<UsageBand, string> = {
  critical: "text-destructive",
  watch: "text-warning",
  ok: "",
};
export const BAND_FILL: Record<UsageBand, string> = {
  critical: "bg-destructive",
  watch: "bg-warning",
  ok: "bg-muted-foreground/40",
};

export function windowBand(window: ServerProviderUsageWindow, settings: UsagePaceSettings) {
  return usageBand(window.usedPercent, settings.watch, settings.critical);
}

const shown = (usedShare: number, display: StatusBarUsagePercentage) =>
  Math.round(display === "remaining" ? 100 - usedShare : usedShare);

const paceText = (deltaPoints: number) =>
  Math.abs(deltaPoints) < 0.1
    ? "on pace"
    : `${Math.round(Math.abs(deltaPoints) * 10) / 10}% ${deltaPoints > 0 ? "over" : "under"} pace`;

export interface PaceView {
  /** Where the tick sits on a bar that fills with the displayed share, 0..100. */
  readonly tickPercent: number;
  /** "+8%" or "−12%"; positive means spending faster than the window elapses. */
  readonly deltaText: string;
  /** "8% over pace", "12% under pace" or "on pace". */
  readonly paceText: string;
  readonly deficit: boolean;
  readonly expectedText: string;
  readonly projectionText: string | null;
  readonly dailyText: string | null;
}

export function pacePresentation(input: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly display: StatusBarUsagePercentage;
  readonly settings: UsagePaceSettings;
  readonly formatAt: (ms: number) => string;
}): PaceView | null {
  const { window, now, display, settings } = input;
  if (!settings.pace) return null;
  const pace = usagePace(window, now);
  if (pace === null) return null;
  const expected = pace.elapsed * 100;
  const { projection } = pace;
  return {
    tickPercent: display === "remaining" ? 100 - expected : expected,
    deltaText: formatPaceDelta(pace.deltaPoints),
    paceText: paceText(pace.deltaPoints),
    deficit: pace.deltaPoints > 0,
    expectedText: `Expected ${shown(expected, display)}%`,
    projectionText:
      !settings.projection || projection === null
        ? null
        : projection.runsOutAt !== null
          ? `Runs out ${input.formatAt(projection.runsOutAt)}`
          : `≈${shown(projection.atResetPercent, display)}% at reset`,
    dailyText:
      settings.dailyBudget && pace.dailyBudgetPercent !== null
        ? `Today: ${Math.round(pace.dailyBudgetPercent)}% of daily budget`
        : null,
  };
}

/** The pooled /usage card averages its accounts, so it has shares but no single reset time. */
export function poolPacePresentation(input: {
  readonly shares: { readonly used: number; readonly elapsed: number } | null;
  readonly settings: UsagePaceSettings;
}): Pick<PaceView, "deltaText" | "paceText" | "deficit" | "projectionText"> | null {
  const { shares, settings } = input;
  if (!settings.pace || shares === null) return null;
  const atReset = settings.projection ? projectedAtReset(shares.used, shares.elapsed) : null;
  return {
    deltaText: formatPaceDelta(shares.used - shares.elapsed * 100),
    paceText: paceText(shares.used - shares.elapsed * 100),
    deficit: shares.used > shares.elapsed * 100,
    projectionText:
      atReset === null
        ? null
        : atReset > 100
          ? "On course to run out"
          : `≈${Math.round(100 - atReset)}% left at reset`,
  };
}
