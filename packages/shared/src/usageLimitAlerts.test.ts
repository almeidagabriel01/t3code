import { describe, expect, it } from "vite-plus/test";

import { mergeUsageLimitAlerts, usageLimitAlertThreshold } from "./usageLimitAlerts.ts";

describe("usageLimitAlertThreshold", () => {
  it.each([
    ["claudeAgent", "seven_day", undefined, 15],
    ["claudeAgent", "five_hour", undefined, null],
    ["claudeAgent", "seven_day_opus", undefined, null],
    ["codex", "secondary", undefined, null],
    ["antigravity", "seven_day", undefined, null],
    ["claudeAgent", "seven_day", "off", null],
    ["claudeAgent", "five_hour", 30, 30],
    ["codex", "secondary", 10, 10],
  ] as const)("%s %s with %j alerts at %j", (driver, windowId, stored, expected) => {
    const config = stored === undefined ? undefined : { windows: { [windowId]: stored } };
    expect(usageLimitAlertThreshold({ driver, windowId, config })).toBe(expected);
  });

  it("treats a dropped stored entry as the default", () => {
    expect(
      usageLimitAlertThreshold({
        driver: "claudeAgent",
        windowId: "seven_day",
        config: { windows: { seven_day: undefined } },
      }),
    ).toBe(15);
  });
});

describe("mergeUsageLimitAlerts", () => {
  it("merges per window, keeps the zone, and drops an emptied instance", () => {
    const current = { a: { windows: { seven_day: 20 as const }, timeZone: "UTC" } };
    const added = mergeUsageLimitAlerts(current, { a: { windows: { five_hour: "off" } } });
    expect(added).toEqual({ a: { windows: { seven_day: 20, five_hour: "off" }, timeZone: "UTC" } });

    const rezoned = mergeUsageLimitAlerts(added, {
      a: { windows: { seven_day: null }, timeZone: "America/Sao_Paulo" },
    });
    expect(rezoned).toEqual({
      a: { windows: { five_hour: "off" }, timeZone: "America/Sao_Paulo" },
    });

    expect(mergeUsageLimitAlerts(rezoned, { a: { windows: { five_hour: null } } })).toEqual({});
    expect(mergeUsageLimitAlerts(current, { a: null, b: { windows: { x: 5 } } })).toEqual({
      b: { windows: { x: 5 } },
    });
  });
});
