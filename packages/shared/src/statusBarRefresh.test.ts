import { describe, expect, it } from "vite-plus/test";

import { shouldRefreshUsage } from "./statusBarRefresh.ts";

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
});
