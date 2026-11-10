import { describe, expect, it } from "vite-plus/test";

import { isRoutineTarget, scheduledTaskWording } from "./scheduledTaskWording.ts";

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
    { assistantTeamId: "team-1", threadId: null, routine: true },
    { assistantTeamId: null, threadId: "assistant:atlas", routine: true },
    { assistantTeamId: "", threadId: "thread-1", routine: false },
    { assistantTeamId: null, threadId: null, routine: false },
  ])("group=$assistantTeamId thread=$threadId is a routine: $routine", ({ routine, ...target }) => {
    expect(isRoutineTarget(target)).toBe(routine);
  });

  it.each([
    { value: "", unit: undefined },
    { value: "  ", unit: undefined },
    { value: "3", unit: "runs" },
  ])("runs unit for '$value'", ({ value, unit }) => {
    expect(scheduledTaskWording(true).runsUnit(value)).toBe(unit);
  });
});
