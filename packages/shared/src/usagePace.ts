import type {
  ClientSettings,
  ServerProviderUsageWindow,
  StatusBarUsagePercentage,
} from "@t3tools/contracts";
import {
  formatPaceDelta,
  PACE_TOLERANCE_POINTS,
  projectedAtReset,
  usageBand,
  usagePace,
  type UsageBand,
} from "./usageLimits.ts";

export const selectUsagePaceSettings = (settings: ClientSettings) => ({
  pace: settings.usagePaceEnabled,
  projection: settings.usageProjectionEnabled,
  dailyBudget: settings.usageDailyBudgetEnabled,
  watch: settings.usageWatchThreshold,
  critical: settings.usageCriticalThreshold,
});
export type UsagePaceSettings = ReturnType<typeof selectUsagePaceSettings>;

export const BAND_TEXT: Record<UsageBand, string> = {
  critical: "text-destructive-foreground",
  watch: "text-warning-foreground",
  ok: "",
};
export const BAND_FILL: Record<UsageBand, string> = {
  critical: "bg-destructive-foreground",
  watch: "bg-warning-foreground",
  ok: "bg-muted-foreground",
};

export interface WeekBarSplit {
  /** Each scoped model's reported share of the week, in report order, capped to what the week used. */
  readonly models: ReadonlyArray<{ readonly name: string; readonly percent: number }>;
  readonly otherPercent: number;
  readonly label: string;
}

const scopedName = (window: ServerProviderUsageWindow) =>
  window.label.replace(/^weekly\s*·\s*/i, "");

/**
 * Splits the account's own weekly bar into each scoped model's reported share and the rest. Null
 * unless a scoped window of the same account carries the share. Bars that fill with the used share
 * draw the model parts at the end of the fill; bars that fill with what is left draw them at the
 * right end of the track, which is the used region.
 */
export function weekBarSplit(
  window: ServerProviderUsageWindow,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  display: StatusBarUsagePercentage,
): WeekBarSplit | null {
  if (window.kind !== "weekly" || window.weekUsedSharePercent !== undefined) return null;
  const scoped = windows.filter(
    (other) =>
      other !== window && other.kind === "weekly" && other.weekUsedSharePercent !== undefined,
  );
  if (scoped.length === 0) return null;
  const used = Math.round(Math.min(100, Math.max(0, window.usedPercent)));
  let room = used;
  const models = scoped.map((other) => {
    const percent = Math.min(room, Math.round(other.weekUsedSharePercent ?? 0));
    room -= percent;
    return { name: scopedName(other), percent };
  });
  const name = window.label === "Weekly" ? "Week" : window.label;
  const parts = [...models.map((m) => `${m.name} ${m.percent}%`), `other models ${room}%`];
  return {
    models,
    otherPercent: room,
    label:
      display === "remaining"
        ? `${name} ${100 - used}% left, used ${parts.join(", ")}`
        : `${name} ${used}% used: ${parts.join(", ")}`,
  };
}

export const weekAllowanceText = (window: ServerProviderUsageWindow) =>
  window.weekAllowancePercent === undefined
    ? null
    : `Up to ${Math.round(window.weekAllowancePercent)}% of the weekly limit`;

export function windowBand(window: ServerProviderUsageWindow, settings: UsagePaceSettings) {
  return usageBand(window.usedPercent, settings.watch, settings.critical);
}

const shown = (usedShare: number, display: StatusBarUsagePercentage) =>
  Math.round(display === "remaining" ? 100 - usedShare : usedShare);

// Same tolerance as paceOf, so every surface agrees on what "on pace" means.
const overPace = (deltaPoints: number) => deltaPoints >= PACE_TOLERANCE_POINTS;
const underPace = (deltaPoints: number) => deltaPoints <= -PACE_TOLERANCE_POINTS;

/** Spending faster than the window elapses is red, slower is green, dead even stays neutral. */
export const paceTextClass = (view: Pick<PaceView, "deficit" | "reserve">) =>
  view.deficit ? "text-destructive-foreground" : view.reserve ? "text-success-foreground" : "";
const paceText = (deltaPoints: number) =>
  Math.abs(deltaPoints) < PACE_TOLERANCE_POINTS
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
  /** Under pace by more than the tolerance. */
  readonly reserve: boolean;
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
    deficit: overPace(pace.deltaPoints),
    reserve: underPace(pace.deltaPoints),
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
}): Pick<PaceView, "deltaText" | "paceText" | "deficit" | "reserve" | "projectionText"> | null {
  const { shares, settings } = input;
  if (!settings.pace || shares === null) return null;
  const atReset = settings.projection ? projectedAtReset(shares.used, shares.elapsed) : null;
  return {
    deltaText: formatPaceDelta(shares.used - shares.elapsed * 100),
    paceText: paceText(shares.used - shares.elapsed * 100),
    deficit: overPace(shares.used - shares.elapsed * 100),
    reserve: underPace(shares.used - shares.elapsed * 100),
    projectionText:
      atReset === null
        ? null
        : atReset > 100
          ? "On course to run out"
          : `≈${Math.round(100 - atReset)}% left at reset`,
  };
}
