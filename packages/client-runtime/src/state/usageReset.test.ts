import type { ServerProviderUsageWindow, UsageResetDisplay } from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { formatCompactCountdown, formatResetLabel, shortLimitName } from "./usageReset.ts";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + ms));
const win = (
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  resetsAt?: string,
  windowDurationMins?: number,
) =>
  ({
    id: label,
    kind,
    label,
    usedPercent: 10,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  }) as ServerProviderUsageWindow;

describe("formatCompactCountdown", () => {
  it("compacts hours, days and minutes", () => {
    expect(formatCompactCountdown(at(3 * HOUR + 49 * 60_000 + 5_000), NOW)).toBe("3h49m");
    expect(formatCompactCountdown(at(3 * 24 * HOUR + 12 * HOUR + 60_000), NOW)).toBe("3d12h");
    expect(formatCompactCountdown(at(12 * 60_000), NOW)).toBe("12m");
  });

  it("handles missing, invalid and elapsed resets", () => {
    expect(formatCompactCountdown(undefined, NOW)).toBeNull();
    expect(formatCompactCountdown("soon", NOW)).toBeNull();
    expect(formatCompactCountdown(at(-1_000), NOW)).toBe("now");
  });
});

describe("shortLimitName", () => {
  it.each([
    [win("weekly", "Weekly · Fable"), "Fable"],
    [win("weekly", "weekly · Opus"), "Opus"],
    [win("monthly", "Monthly · Sonnet"), "Sonnet"],
    [win("session", "5-hour"), "Session"],
    [win("weekly", "Weekly"), "Week"],
    [win("weekly", "Go · Weekly"), "Week"],
    [win("monthly", "Monthly"), "Month"],
    [win("other", "Credits"), "Credits"],
  ])("%j reads as %s", (window, expected) => {
    expect(shortLimitName(window)).toBe(expected);
  });
});

describe("formatResetLabel", () => {
  // Thursday 2026-11-12 18:00 in UTC is Friday 03:00 in Tokyo.
  const thursday = "2026-11-12T18:00:00.000Z";
  const weekly = win("weekly", "Weekly", thursday);
  const run = (
    window: ServerProviderUsageWindow,
    mode: UsageResetDisplay,
    extra: { locale?: string; timeZone?: string; hour12?: boolean } = {},
  ) => formatResetLabel({ window, mode, now: NOW, locale: "en-US", timeZone: "UTC", ...extra });

  it("shows the day, the countdown or both for a multi-day limit", () => {
    expect(run(weekly, "day")?.label).toBe("Thu 12");
    expect(run(weekly, "countdown")?.label).toBe("3d6h");
    expect(run(weekly, "both")?.label).toBe("Thu 12 · 3d6h");
    expect(run(weekly, "day")?.phrase).toBe("Resets Thu 12");
    expect(run(weekly, "countdown")?.phrase).toBe("Resets in 3d6h");
    expect(run(weekly, "both")?.phrase).toBe("Resets Thu 12 · in 3d6h");
  });

  it("follows the time zone and the locale", () => {
    expect(run(weekly, "day", { timeZone: "Asia/Tokyo" })?.label).toBe("Fri 13");
    expect(run(weekly, "day", { locale: "pt-BR" })?.label).toBe("qui. 12");
  });

  it("shows the time instead of the day within 24 hours", () => {
    const soon = win("weekly", "Weekly", at(6 * HOUR));
    expect(run(soon, "day", { hour12: false })?.label).toBe("18:00");
    expect(run(soon, "day", { locale: "en-US" })?.label).toBe("6:00 PM");
    expect(run(soon, "both", { hour12: false })?.label).toBe("18:00 · 6h0m");
  });

  it("keeps the countdown for the session limit in every mode", () => {
    const session = win("session", "5-hour", at(2 * HOUR), 300);
    for (const mode of ["day", "countdown", "both"] as const) {
      expect(run(session, mode)?.label).toBe("2h0m");
    }
  });

  it("treats an unlabelled window of a day or more as multi-day", () => {
    expect(run(win("other", "Credits", thursday, 7 * 24 * 60), "day")?.label).toBe("Thu 12");
    expect(run(win("other", "Credits", thursday), "day")?.label).toBe("3d6h");
  });

  it("puts the exact date and the countdown in the tooltip", () => {
    expect(run(weekly, "day", { hour12: false })?.title).toBe(
      "Resets Thu, Nov 12, 18:00 (in 3d6h)",
    );
    expect(run(weekly, "countdown", { hour12: false })?.title).toBe(
      "Resets Thu, Nov 12, 18:00 (in 3d6h)",
    );
  });

  it("says now once the reset has passed, and nothing without one", () => {
    expect(run(win("weekly", "Weekly", at(-HOUR)), "day")).toEqual({
      label: "now",
      title: "Resets now",
      phrase: "Resets now",
    });
    expect(run(win("weekly", "Weekly"), "day")).toBeNull();
  });
});
