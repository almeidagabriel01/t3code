import type { ScheduledTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeSchedule, formatTime } from "./scheduledTaskPresentation";

const task = (schedule: unknown) => ({ schedule }) as ScheduledTask;
const at9 = formatTime("09:00");

describe("describeSchedule", () => {
  it.each([
    [{ type: "webhook" }, "On webhook"],
    [{ type: "interval", everyMs: 3_600_000 }, null],
    [{ type: "daily", timeOfDay: "09:00" }, `Every day at ${at9}`],
    [{ type: "daily", timeOfDay: "09:00", weekdays: [] }, `Every day at ${at9}`],
    [{ type: "daily", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, `Every day at ${at9}`],
    [{ type: "daily", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }, `Weekdays at ${at9}`],
    [{ type: "daily", timeOfDay: "09:00", weekdays: [0, 3] }, `Wed, Sun at ${at9}`],
  ])("describes %j", (schedule, expected) => {
    const label = describeSchedule(task(schedule));
    if (expected === null) expect(label).not.toBe("");
    else expect(label).toBe(expected);
  });
});

describe("formatTime", () => {
  it("passes unparseable input through", () => {
    expect(formatTime("soon")).toBe("soon");
    expect(formatTime("9:xx")).toBe("9:xx");
  });
  it("formats a valid time", () => {
    expect(formatTime("14:30")).toMatch(/2:30|14:30/);
  });
});
