import { describe, expect, it } from "vite-plus/test";

import { scheduledTaskWording } from "./scheduledTaskWording.ts";

describe("scheduledTaskWording", () => {
  it.each([
    { group: true, noun: "routine", section: "Routine" },
    { group: false, noun: "task", section: "Task" },
  ])("names a group=$group item $noun", ({ group, noun, section }) => {
    const wording = scheduledTaskWording(group);
    expect(wording.noun).toBe(noun);
    expect(wording.section).toBe(section);
    expect(wording.runLimitHint).toBe(
      `The ${noun} turns itself off after this many runs. Empty means no limit.`,
    );
  });

  it.each([
    { value: "", unit: undefined },
    { value: "  ", unit: undefined },
    { value: "3", unit: "runs" },
  ])("runs unit for '$value'", ({ value, unit }) => {
    expect(scheduledTaskWording(true).runsUnit(value)).toBe(unit);
  });
});
