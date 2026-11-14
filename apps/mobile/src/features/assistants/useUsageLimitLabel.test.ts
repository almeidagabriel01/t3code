import { describe, expect, it } from "vite-plus/test";

import { formatUpcomingTime } from "./useUsageLimitLabel";

describe("formatUpcomingTime", () => {
  const now = new Date(2026, 10, 14, 12, 0).getTime();
  const at = (day: number) => new Date(2026, 10, day, 15, 30);
  const time = at(14).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  it.each([
    [14, time],
    [15, `tomorrow at ${time}`],
    [17, `${at(17).toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`],
  ])("reads day %s", (day, expected) => {
    expect(formatUpcomingTime(at(day).toISOString(), now)).toBe(expected);
  });
});
