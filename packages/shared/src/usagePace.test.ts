import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  pacePresentation,
  paceTextClass,
  poolPacePresentation,
  type UsagePaceSettings,
  weekAllowanceText,
  weekBarSplit,
} from "./usagePace.ts";

const settings: UsagePaceSettings = {
  pace: true,
  projection: true,
  dailyBudget: false,
  watch: 50,
  critical: 70,
};
const now = Date.parse("2026-09-03T12:00:00.000Z");
const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 30,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const formatAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

describe("pacePresentation", () => {
  it("mirrors the tick and the figures when the bar shows what is left", () => {
    const used = pacePresentation({ window, now, display: "used", settings, formatAt })!;
    const left = pacePresentation({ window, now, display: "remaining", settings, formatAt })!;
    expect([used.tickPercent, left.tickPercent]).toEqual([60, 40]);
    expect(used.expectedText).toBe("Expected 60%");
    expect(left.expectedText).toBe("Expected 40%");
    expect(used.deltaText).toBe("−30%");
    expect(used.paceText).toBe("30% under pace");
    expect(used.deficit).toBe(false);
    expect(used.projectionText).toBe("≈50% at reset");
    expect(left.projectionText).toBe("≈50% at reset");
  });

  it("calls any visible overspend over pace, with no grace margin", () => {
    const at = (usedPercent: number) => {
      const view = pacePresentation({
        window: { ...window, usedPercent },
        now,
        display: "used",
        settings,
        formatAt,
      })!;
      return [view.paceText, paceTextClass(view)];
    };
    expect([at(60), at(60.05), at(61.7), at(54)]).toEqual([
      ["on pace", ""],
      ["on pace", ""],
      ["1.7% over pace", "text-destructive-foreground"],
      ["6% under pace", "text-success-foreground"],
    ]);
  });

  it("names the run-out time on a deficit and honors the toggles", () => {
    const hot = { ...window, usedPercent: 80 };
    const view = pacePresentation({ window: hot, now, display: "used", settings, formatAt })!;
    expect(view.deficit).toBe(true);
    expect(view.projectionText).toBe("Runs out 2026-09-03T12:45:00.000Z");
    const quiet = { ...settings, projection: false };
    expect(
      pacePresentation({ window: hot, now, display: "used", settings: quiet, formatAt })!
        .projectionText,
    ).toBeNull();
    expect(
      pacePresentation({
        window: hot,
        now,
        display: "used",
        settings: { ...settings, pace: false },
        formatAt,
      }),
    ).toBeNull();
  });

  it("shows the daily budget for weekly windows only when enabled", () => {
    const weekly = {
      ...window,
      kind: "weekly",
      usedPercent: 30,
      windowDurationMins: 7 * 1440,
      resetsAt: "2026-09-08T12:00:00.000Z",
    } as const;
    const on = { ...settings, dailyBudget: true };
    expect(
      pacePresentation({ window: weekly, now, display: "used", settings: on, formatAt })!.dailyText,
    ).toBe("Today: 70% of daily budget");
    expect(
      pacePresentation({ window: weekly, now, display: "used", settings, formatAt })!.dailyText,
    ).toBeNull();
  });
});

describe("poolPacePresentation", () => {
  it("projects from the pooled shares", () => {
    expect(poolPacePresentation({ shares: { used: 80, elapsed: 0.6 }, settings })).toEqual({
      deltaText: "+20%",
      paceText: "20% over pace",
      deficit: true,
      reserve: false,
      projectionText: "On course to run out",
    });
    expect(poolPacePresentation({ shares: null, settings })).toBeNull();
  });
});

describe("weekBarSplit", () => {
  const week = { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 84 } as const;
  const scoped = (name: string, share: number | undefined) => ({
    id: `seven_day_${name}`,
    kind: "weekly" as const,
    label: `Weekly · ${name}`,
    usedPercent: 40,
    ...(share === undefined ? {} : { weekUsedSharePercent: share, weekAllowancePercent: 50 }),
  });
  it.each([
    ["used", [week, scoped("Fable", 20)], 84, [20], "Week 84% used: Fable 20%, other models 64%"],
    [
      "remaining",
      [week, scoped("Fable", 20)],
      84,
      [20],
      "Week 16% left, used Fable 20%, other models 64%",
    ],
    [
      "share above the week",
      [week, scoped("Fable", 90)],
      84,
      [84],
      "Week 84% used: Fable 84%, other models 0%",
    ],
    [
      "zero share",
      [week, scoped("Fable", 0)],
      84,
      [0],
      "Week 84% used: Fable 0%, other models 84%",
    ],
    [
      "two models in report order",
      [week, scoped("Fable", 20), scoped("Opus", 70)],
      84,
      [20, 64],
      "Week 84% used: Fable 20%, Opus 64%, other models 0%",
    ],
  ] as const)("%s", (name, windows, _used, bars, label) => {
    const split = weekBarSplit(week, windows, name === "remaining" ? "remaining" : "used");
    expect({ ...split, models: split?.models.map((m) => m.percent) }).toEqual({
      models: bars,
      otherPercent: _used - bars.reduce<number>((sum, bar) => sum + bar, 0),
      label,
    });
  });
  it("is null without a share, for session windows and for the scoped window itself", () => {
    expect(weekBarSplit(week, [week, scoped("Fable", undefined)], "used")).toBeNull();
    expect(weekBarSplit(window, [window, scoped("Fable", 20)], "used")).toBeNull();
    const fable = scoped("Fable", 20);
    expect(weekBarSplit(fable, [week, fable], "used")).toBeNull();
  });
  it("words the allowance the way the provider does", () => {
    expect(weekAllowanceText(scoped("Fable", 20))).toBe("Up to 50% of the weekly limit");
    expect(weekAllowanceText(scoped("Fable", undefined))).toBeNull();
  });
});
