import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { pacePresentation, poolPacePresentation, type UsagePaceSettings } from "./usagePace.ts";

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
      projectionText: "On course to run out",
    });
    expect(poolPacePresentation({ shares: null, settings })).toBeNull();
  });
});
