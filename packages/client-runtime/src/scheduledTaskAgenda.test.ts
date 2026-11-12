// @effect-diagnostics globalDate:off - Builds local wall-clock fixtures for the agenda.
import { ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { KANBAN_COLORS } from "./state/kanbanLogic.ts";
import {
  agendaEntryDetail,
  localDayStarts,
  scheduledTaskAgenda,
  scheduledTaskColor,
  scheduledTaskIsUpcoming,
  sortScheduledTasks,
} from "./scheduledTaskAgenda.ts";

/** Thursday 12 November 2026, local time. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();
const iso = (time: number) => new Date(time).toISOString();
const NOW = at(12, 9);
const DAYS = localDayStarts(NOW, 2);
const HOUR = 3_600_000;

const task = (id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask =>
  ({
    id: ScheduledTaskId.make(id),
    title: id,
    enabled: true,
    schedule: { type: "interval", everyMs: 8 * HOUR },
    nextRunAt: iso(at(12, 10)),
    lastRunAt: null,
    lastRunStatus: "never",
    runCount: 0,
    ...overrides,
  }) as ScheduledTask;

const times = (days: ReturnType<typeof scheduledTaskAgenda>) =>
  days.map((day) =>
    day.entries.map((entry) => {
      const date = new Date(entry.at);
      const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
      return `${entry.task.title}@${time}${entry.runs > 1 ? `x${entry.runs}` : ""}${entry.past ? " (ran)" : ""}`;
    }),
  );

describe("localDayStarts", () => {
  it("returns each local midnight and the end of the last day", () => {
    expect(DAYS).toEqual([at(12, 0), at(13, 0), at(14, 0)]);
  });
});

describe("scheduledTaskAgenda", () => {
  it.each<[string, ScheduledTask, string[][]]>([
    [
      "a one-off run today",
      task("once", {
        schedule: { type: "once", runAt: iso(at(12, 15)) },
        nextRunAt: iso(at(12, 15)),
      }),
      [["once@15:00"], []],
    ],
    [
      "a daily run on both days",
      task("daily", {
        schedule: { type: "fixed_time", timeOfDay: "18:00" },
        nextRunAt: iso(at(12, 18)),
      }),
      [["daily@18:00"], ["daily@18:00"]],
    ],
    [
      "a Friday-only run tomorrow",
      task("friday", {
        schedule: { type: "fixed_time", timeOfDay: "18:00", weekdays: [5] },
        nextRunAt: iso(at(13, 18)),
      }),
      [[], ["friday@18:00"]],
    ],
    [
      "a few interval runs as separate blocks",
      task("every8h"),
      [
        ["every8h@10:00", "every8h@18:00"],
        ["every8h@2:00", "every8h@10:00", "every8h@18:00"],
      ],
    ],
    [
      "a frequent interval collapsed into one block a day",
      task("hourly", { schedule: { type: "interval", everyMs: HOUR } }),
      [["hourly@10:00x14"], ["hourly@0:00x24"]],
    ],
    [
      "a sub-minute legacy interval counted at the one-minute floor",
      task("legacy", { schedule: { type: "interval", everyMs: 1_000 } }),
      [["legacy@10:00x840"], ["legacy@0:00x1440"]],
    ],
    [
      "only the runs left under the run limit",
      task("capped", { maxRuns: 3, runCount: 1 }),
      [["capped@10:00", "capped@18:00"], []],
    ],
    ["nothing for a paused task", task("paused", { enabled: false }), [[], []]],
    [
      "nothing for a webhook task",
      task("hook", { schedule: { type: "webhook" } as ScheduledTask["schedule"], nextRunAt: null }),
      [[], []],
    ],
    [
      "nothing for a blocked task",
      task("blocked", { blockedByPolicy: "Disabled by policy" }),
      [[], []],
    ],
    [
      "today's last run, even when paused",
      task("ran", { enabled: false, lastRunAt: iso(at(12, 7)), lastRunStatus: "succeeded" }),
      [["ran@7:00 (ran)"], []],
    ],
    [
      "no block for a run on an earlier day",
      task("yesterday", { enabled: false, lastRunAt: iso(at(11, 22)) }),
      [[], []],
    ],
  ])("places %s", (_name, input, expected) => {
    expect(times(scheduledTaskAgenda([input], NOW, DAYS))).toEqual(expected);
  });

  it("orders blocks from different tasks by time, then title", () => {
    const agenda = scheduledTaskAgenda(
      [
        task("b", {
          schedule: { type: "once", runAt: iso(at(12, 15)) },
          nextRunAt: iso(at(12, 15)),
        }),
        task("a", {
          schedule: { type: "once", runAt: iso(at(12, 15)) },
          nextRunAt: iso(at(12, 15)),
        }),
        task("early", { enabled: false, lastRunAt: iso(at(12, 8)) }),
      ],
      NOW,
      DAYS,
    );
    expect(times(agenda)[0]).toEqual(["early@8:00 (ran)", "a@15:00", "b@15:00"]);
  });
});

describe("scheduledTaskIsUpcoming", () => {
  it("rejects an unparseable next run", () => {
    expect(scheduledTaskIsUpcoming(task("bad", { nextRunAt: "not a date" }))).toBe(false);
  });
});

describe("sortScheduledTasks", () => {
  it("lists the next run first, then tasks without a time, then paused ones", () => {
    const sorted = sortScheduledTasks([
      task("paused", { enabled: false }),
      task("hook", { schedule: { type: "webhook" } as ScheduledTask["schedule"], nextRunAt: null }),
      task("later", { nextRunAt: iso(at(13, 9)) }),
      task("soon", { nextRunAt: iso(at(12, 9, 30)) }),
    ]);
    expect(sorted.map((entry) => entry.title)).toEqual(["soon", "later", "hook", "paused"]);
  });
});

describe("agendaEntryDetail", () => {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    at(12, 10),
  );
  it.each([
    ["an upcoming run", { past: false, runs: 1 }, {}, time],
    ["folded runs", { past: false, runs: 4 }, {}, `${time} · 4 runs`],
    ["a past run", { past: true, runs: 1 }, { lastRunStatus: "failed" }, `${time} · failed`],
    ["a past run with no status", { past: true, runs: 1 }, {}, `${time} · ran`],
  ] as const)("describes %s", (_name, entry, overrides, expected) => {
    expect(agendaEntryDetail({ ...entry, at: at(12, 10), task: task("a", overrides) })).toBe(
      expected,
    );
  });
});

describe("scheduledTaskColor", () => {
  it("gives each task a stable palette color", () => {
    const ids = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const colors = ids.map(scheduledTaskColor);
    expect(ids.map(scheduledTaskColor)).toEqual(colors);
    for (const color of colors) expect(KANBAN_COLORS[color]).toBeDefined();
    expect(new Set(colors).size).toBeGreaterThan(1);
  });
});
