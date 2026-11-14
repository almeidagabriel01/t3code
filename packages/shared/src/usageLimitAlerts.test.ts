import { describe, expect, it } from "vite-plus/test";

import {
  mergeUsageLimitAlerts,
  usageLimitAlertChoices,
  usageLimitAlertRows,
  usageLimitAlertThreshold,
} from "./usageLimitAlerts.ts";

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

describe("usageLimitAlertRows", () => {
  it("lists reported windows in order and a default window before its first reading", () => {
    expect(
      usageLimitAlertRows({ driver: "claudeAgent", windows: undefined, config: undefined }),
    ).toEqual([{ windowId: "seven_day", label: "Weekly", threshold: 15 }]);
    expect(
      usageLimitAlertRows({
        driver: "claudeAgent",
        windows: [
          { id: "five_hour", label: "Session" },
          { id: "seven_day", label: "Weekly" },
          { id: "seven_day_opus", label: "Weekly · Opus" },
        ],
        config: { windows: { five_hour: 10, seven_day: "off" } },
      }),
    ).toEqual([
      { windowId: "five_hour", label: "Session", threshold: 10 },
      { windowId: "seven_day", label: "Weekly", threshold: null },
      { windowId: "seven_day_opus", label: "Weekly · Opus", threshold: null },
    ]);
    expect(usageLimitAlertRows({ driver: "codex", windows: [], config: undefined })).toEqual([]);
  });

  it("keeps a saved value outside the fixed choices selectable", () => {
    expect(usageLimitAlertChoices(15)).toEqual([5, 10, 15, 20, 25, 30, 40, 50]);
    expect(usageLimitAlertChoices(12)).toEqual([5, 10, 12, 15, 20, 25, 30, 40, 50]);
    expect(usageLimitAlertChoices(null)).toEqual([5, 10, 15, 20, 25, 30, 40, 50]);
  });
});
