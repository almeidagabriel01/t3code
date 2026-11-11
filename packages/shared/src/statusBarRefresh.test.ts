import { describe, expect, it } from "vite-plus/test";

import { shouldRefreshUsage, usageReadingAt } from "./statusBarRefresh.ts";

describe("shouldRefreshUsage", () => {
  const base = { intervalMs: 60_000, hidden: false, lastRefreshAt: 0, now: 60_000 };
  it("refreshes once the interval has elapsed", () => {
    expect(shouldRefreshUsage(base)).toBe(true);
    expect(shouldRefreshUsage({ ...base, now: 59_999 })).toBe(false);
  });
  it("never refreshes when manual or hidden", () => {
    expect(shouldRefreshUsage({ ...base, intervalMs: null })).toBe(false);
    expect(shouldRefreshUsage({ ...base, hidden: true })).toBe(false);
  });
  it.each([
    {
      name: "a fresh server reading",
      readings: ["2026-01-01T00:09:30Z"],
      intervalMs: 60_000,
      due: false,
    },
    {
      name: "a stale server reading",
      readings: ["2026-01-01T00:08:00Z"],
      intervalMs: 60_000,
      due: true,
    },
    {
      name: "the oldest of several readings",
      readings: ["2026-01-01T00:09:59Z", "2026-01-01T00:01:00Z"],
      intervalMs: 60_000,
      due: true,
    },
    { name: "no reading yet", readings: [], intervalMs: 60_000, due: true },
    { name: "an unreadable reading", readings: ["soon"], intervalMs: 60_000, due: true },
    {
      name: "manual mode with a reading",
      readings: ["2026-01-01T00:00:00Z"],
      intervalMs: null,
      due: false,
    },
    { name: "manual mode with no reading", readings: [], intervalMs: null, due: true },
  ])("opening the page with $name refreshes: $due", ({ readings, intervalMs, due }) => {
    expect(
      shouldRefreshUsage({
        intervalMs,
        hidden: false,
        lastRefreshAt: usageReadingAt(readings),
        now: Date.parse("2026-01-01T00:10:00Z"),
        opening: true,
      }),
    ).toBe(due);
  });
});
