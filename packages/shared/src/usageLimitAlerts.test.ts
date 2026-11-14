import { describe, expect, it } from "vite-plus/test";

import {
  mergeUsageLimitAlerts,
  usageLimitAlertChoices,
  usageLimitAlertOverride,
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
  const at = (instances: Record<string, unknown>, ignoreAutonomyPause = true) =>
    ({ ignoreAutonomyPause, instances }) as never;
  const edit = (instances: Record<string, unknown>) => ({ instances }) as never;

  it("merges per window, keeps the zone, and drops an instance left with neither", () => {
    const current = at({ a: { windows: { seven_day: 20 }, timeZone: "UTC" } });
    const added = mergeUsageLimitAlerts(current, edit({ a: { windows: { five_hour: "off" } } }));
    expect(added).toEqual(
      at({ a: { windows: { seven_day: 20, five_hour: "off" }, timeZone: "UTC" } }),
    );

    const rezoned = mergeUsageLimitAlerts(
      added,
      edit({ a: { windows: { seven_day: null }, timeZone: "America/Sao_Paulo" } }),
    );
    expect(rezoned).toEqual(
      at({ a: { windows: { five_hour: "off" }, timeZone: "America/Sao_Paulo" } }),
    );

    // Back on defaults, the zone still names the reset time of the default alerts.
    expect(mergeUsageLimitAlerts(rezoned, edit({ a: { windows: { five_hour: null } } }))).toEqual(
      at({ a: { windows: {}, timeZone: "America/Sao_Paulo" } }),
    );
    expect(mergeUsageLimitAlerts(at({}), edit({ a: { timeZone: "UTC" } }))).toEqual(
      at({ a: { windows: {}, timeZone: "UTC" } }),
    );
    expect(
      mergeUsageLimitAlerts(
        at({ a: { windows: { x: 5 } } }),
        edit({ a: { windows: { x: null } } }),
      ),
    ).toEqual(at({}));
    expect(mergeUsageLimitAlerts(current, edit({ a: null, b: { windows: { x: 5 } } }))).toEqual(
      at({ b: { windows: { x: 5 } } }),
    );
  });

  it("sets the Autonomy pause choice without touching the instances", () => {
    const current = at({ a: { windows: { x: 5 } } });
    expect(mergeUsageLimitAlerts(current, { ignoreAutonomyPause: false })).toEqual(
      at({ a: { windows: { x: 5 } } }, false),
    );
    expect(mergeUsageLimitAlerts(at({}, false), {})).toEqual(at({}, false));
  });
});

describe("usageLimitAlertOverride", () => {
  it.each([
    ["claudeAgent", "seven_day", 15, null],
    ["claudeAgent", "seven_day", "off", "off"],
    ["claudeAgent", "seven_day", 20, 20],
    ["claudeAgent", "five_hour", "off", null],
    ["claudeAgent", "five_hour", 15, 15],
  ] as const)("%s %s picked %j stores %j", (driver, windowId, threshold, expected) => {
    expect(usageLimitAlertOverride({ driver, windowId, threshold })).toBe(expected);
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
