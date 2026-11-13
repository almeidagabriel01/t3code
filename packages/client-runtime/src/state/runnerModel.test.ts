import type { HeavyQueueEntry, HeavyRunnerLinux } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  askRemaining,
  heavyLimitIdle,
  heavyModeLine,
  linuxLine,
  moveAllActions,
  routeActions,
  RUNNER_SETTING_COPY,
  RUNNER_WHERE_DESCRIPTION,
  runnerModeFieldApplies,
  runnerBadge,
  runnerFieldIdle,
  type RunnerChoices,
} from "./runnerModel.ts";

const entry = (extra: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id: "a",
  pid: 1,
  threadId: null,
  label: "vp test run",
  cwd: "/w",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  ...extra,
});
const linux: HeavyRunnerLinux = {
  host: "pc",
  online: true,
  slots: 2,
  running: 1,
  load1: 1.234,
  cpuCount: 6,
  availableMemoryBytes: 8.1 * 1024 ** 3,
  totalMemoryBytes: 12 * 1024 ** 3,
};

describe("the queue × Runner line", () => {
  const line = (
    queueEnabled: boolean,
    queuePaused: boolean,
    runnerEnabled: boolean,
    where: "mac" | "linux" | "automatic" | "macFirst",
  ) => heavyModeLine({ queueEnabled, queuePaused, runnerEnabled, where });

  it.each([
    [true, false, false, "mac", "Heavy jobs wait their turn on this Mac."],
    [true, true, false, "mac", "Queue paused: nothing new starts on this Mac."],
    [false, false, false, "linux", "Heavy jobs start right away, with nothing tracking them."],
    [true, true, true, "linux", "Queue paused: nothing new starts on this Mac or Linux."],
    [true, false, true, "mac", "Heavy jobs wait their turn on this Mac; nothing goes to Linux."],
    [
      true,
      false,
      true,
      "linux",
      "Listed commands run on Linux; everything else waits its turn on this Mac.",
    ],
    [
      true,
      false,
      true,
      "automatic",
      "Each job goes to the machine with the shorter queue. Neither starts a job past its own limits.",
    ],
    [false, false, true, "mac", "No queue: heavy jobs start on this Mac right away."],
    [
      false,
      false,
      true,
      "linux",
      "No queue: listed commands wait for a Linux slot, the rest start here right away.",
    ],
    [
      false,
      true,
      true,
      "automatic",
      "Each job goes to the machine with the shorter queue. Neither starts a job past its own limits.",
    ],
    [
      true,
      false,
      true,
      "macFirst",
      "Jobs run on this Mac until it has this many running or waiting, then on Linux.",
    ],
    [
      false,
      false,
      true,
      "macFirst",
      "Jobs run on this Mac until it has this many running or waiting, then on Linux.",
    ],
  ] as const)("queue %s paused %s Runner %s %s", (queue, paused, runner, where, text) => {
    expect(line(queue, paused, runner, where)).toBe(text);
  });
});

describe("Linux status", () => {
  it.each([
    [linux, "Linux online · 1 of 2 running · load 1.2 on 6 cores · 8.1 GB free"],
    [{ ...linux, load1: null, availableMemoryBytes: null }, "Linux online · 1 of 2 running"],
    [{ ...linux, cpuCount: null }, "Linux online · 1 of 2 running · load 1.2 · 8.1 GB free"],
    [{ ...linux, online: false, error: "Connection refused" }, "Linux offline: Connection refused"],
    [{ ...linux, online: false }, "Linux offline"],
    [{ ...linux, online: null }, "Checking Linux (pc)…"],
  ] as const)("%j reads %s", (state, text) => {
    expect(linuxLine(state)).toBe(text);
  });

  it("counts the answer down and never goes negative", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(askRemaining("2026-01-01T00:04:05.000Z", now)).toBe("4:05");
    expect(askRemaining("2026-01-01T00:00:00.500Z", now)).toBe("0:01");
    expect(askRemaining("2025-12-31T23:59:00.000Z", now)).toBe("0:00");
  });
});

describe("a row's runner", () => {
  const state = { linux, routes: { a: "linux" as const }, macOnly: [] as string[] };

  it.each([
    [entry(), { linux: null, routes: {} }, null],
    [
      entry({ startedAt: "x", runner: "linux", phase: "installing" }),
      { linux: null, routes: {} },
      { runner: "linux", label: "Linux · Installing" },
    ],
    [entry({ startedAt: "x", runner: "linux" }), state, { runner: "linux", label: "Linux" }],
    [entry({ startedAt: "x" }), state, { runner: "mac", label: "This Mac" }],
    [entry(), state, { runner: "linux", label: "Linux" }],
    [entry({ id: "b" }), state, { runner: "mac", label: "This Mac" }],
  ] as const)("%#", (row, rowState, badge) => {
    expect(runnerBadge(row, rowState)).toEqual(badge);
  });

  it("offers both runners to a waiter, and only the other one to a running job, with a confirm", () => {
    expect(routeActions(entry(), state).map((action) => action.runner)).toEqual(["mac", "linux"]);
    expect(routeActions(entry({ route: "linux" }), state).map((a) => a.runner)).toEqual(["mac"]);
    const running = routeActions(entry({ startedAt: "x", runner: "linux" }), state);
    expect(running).toEqual([
      {
        runner: "mac",
        label: "Run on this Mac",
        confirm: "Stop this job and run it again on this Mac? Work it has done so far is lost.",
        force: false,
      },
    ]);
  });

  it("keeps Mac-only work and server slots off Linux, and offers nothing with the Runner off", () => {
    expect(routeActions(entry(), { ...state, macOnly: ["a"] }).map((a) => a.runner)).toEqual([
      "mac",
    ]);
    expect(routeActions(entry({ server: true }), state)).toEqual([]);
    expect(routeActions(entry(), { ...state, linux: null })).toEqual([]);
  });

  it("an unconfirmed drop reruns only with a warning and force", () => {
    const [mac] = routeActions(entry({ unconfirmed: true }), state);
    expect(mac).toMatchObject({ force: true, confirm: expect.stringContaining("run it twice") });
  });
});

describe("Move all", () => {
  const base = {
    entries: [entry()],
    linux,
    routes: {} as Record<string, "mac" | "linux">,
    macOnly: [] as string[],
  };
  const labels = (state: Parameters<typeof moveAllActions>[0]) =>
    moveAllActions(state).map((action) => action.label);

  it.each([
    ["a waiter headed here can go to Linux", base, ["Move all to Linux"]],
    [
      "a waiter headed to Linux can come back",
      { ...base, routes: { a: "linux" } },
      ["Move all to this Mac"],
    ],
    [
      "waiters on both sides offer both ways",
      { ...base, entries: [entry(), entry({ id: "b" })], routes: { b: "linux" } },
      ["Move all to this Mac", "Move all to Linux"],
    ],
    ["Mac-only work stays", { ...base, macOnly: ["a"] }, []],
    ["a job asked for this Mac stays", { ...base, entries: [entry({ where: "mac" })] }, []],
    ["running jobs stay", { ...base, entries: [entry({ startedAt: "x" })] }, []],
    ["an unconfirmed run stays", { ...base, entries: [entry({ unconfirmed: true })] }, []],
    ["a server slot stays", { ...base, entries: [entry({ server: true })] }, []],
    ["no Runner, no Linux target", { ...base, linux: null }, []],
    [
      "no Runner still brings Linux waiters back",
      { ...base, linux: null, routes: { a: "linux" } },
      ["Move all to this Mac"],
    ],
  ] as const)("%s", (_name, state, expected) => {
    expect(labels(state as never)).toEqual(expected);
  });
});

describe("Runner copy and mode fields", () => {
  it.each([
    [RUNNER_SETTING_COPY.runnerDropped.title, "If a Linux run fails"],
    [
      RUNNER_SETTING_COPY.runnerDropped.description,
      "What a job does when Linux couldn't run it: the PC went away, or a tool or folder is missing there.",
    ],
    [
      RUNNER_SETTING_COPY.runnerWhere.description,
      "This Mac keeps everything here. Mac first fills this Mac, then sends the rest to Linux. Hybrid splits jobs between both. Linux sends the listed commands there.",
    ],
    [
      RUNNER_WHERE_DESCRIPTION.automatic,
      "Each job goes to the machine with the shorter queue. Neither starts a job past its own limits.",
    ],
  ])("%s", (text, expected) => {
    expect(text).toBe(expected);
  });

  it.each([
    ["runnerMacFirstAfter", "macFirst", true],
    ["runnerMacFirstAfter", null, true],
    ["runnerMacFirstAfter", "linux", false],
    ["runnerLinuxEverything", "linux", true],
    ["runnerLinuxEverything", null, true],
    ["runnerLinuxEverything", "macFirst", false],
    ["runnerBringBack", "mac", true],
  ] as const)("%s under %s: %s", (key, where, applies) => {
    expect(runnerModeFieldApplies(key, where)).toBe(applies);
  });
});

describe("Runner fields that do nothing under the current choices", () => {
  const on: RunnerChoices = {
    runnerEnabled: true,
    runnerWhere: "linux",
    runnerUnavailable: "ask",
    runnerDropped: "mac",
  };

  it.each([
    ["runnerEnabled", { runnerEnabled: false }, null],
    ["runnerHost", { runnerEnabled: false }, "Only applies while the Runner is on."],
    ["runnerHost", {}, null],
    [
      "runnerLinuxCommands",
      { runnerWhere: "mac" },
      "Only applies when jobs run on Linux or Hybrid.",
    ],
    ["runnerLinuxCommands", { runnerWhere: null }, null],
    ["runnerAskMinutes", {}, null],
    ["runnerDeadlineAction", { runnerUnavailable: null }, null],
    [
      "runnerAskMinutes",
      { runnerUnavailable: "wait" },
      "Only applies when a choice above is Ask me.",
    ],
  ] as const)("%s with %o: %s", (key, choices, idle) => {
    expect(runnerFieldIdle(key, { ...on, ...choices })).toBe(idle);
  });
});

describe("heavyLimitIdle", () => {
  const QUEUE_OFF = "Only applies while the heavy work queue is on or jobs run in Hybrid.";
  const BOTH_OFF = "Only applies while the heavy work queue or the Runner is on.";
  it.each([
    ["macCpuCeilingPercent", true, false, "mac", null],
    ["macCpuCeilingPercent", false, true, "automatic", null],
    ["macCpuCeilingPercent", false, true, null, null],
    ["macCpuCeilingPercent", false, null, "automatic", null],
    ["macCpuCeilingPercent", false, true, "linux", QUEUE_OFF],
    ["macMemoryFloorPercent", false, true, "mac", QUEUE_OFF],
    ["macMemoryFloorPercent", false, false, "automatic", QUEUE_OFF],
    ["heavyOverLimitSeconds", false, true, "linux", null],
    ["heavyOverLimitSeconds", true, false, "mac", null],
    ["heavyOverLimitSeconds", false, false, "automatic", BOTH_OFF],
  ] as const)(
    "%s with queue %s, Runner %s, %s",
    (key, queueEnabled, runnerEnabled, runnerWhere, idle) => {
      expect(heavyLimitIdle(key, { queueEnabled, runnerEnabled, runnerWhere })).toBe(idle);
    },
  );
});
