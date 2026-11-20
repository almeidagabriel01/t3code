import type { HeavyQueueEntry, HeavyRunnerLinux } from "@t3tools/contracts";
import { RunnerLinuxFullPolicy } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  askRemaining,
  heavyLimitIdle,
  heavyModeLine,
  linuxLine,
  moveAllActions,
  askAnswers,
  routeActions,
  RUNNER_SETTING_COPY,
  RUNNER_WHERE_DESCRIPTION,
  runnerModeFieldApplies,
  runnerModeFieldIdle,
  RUNNER_LINUX_FULL_DESCRIPTION,
  RUNNER_LINUX_FULL_LABEL,
  runnerWhereLine,
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
  cpuPercent: 12.4,
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
      "Heavy jobs Linux can run go there; what needs this Mac waits its turn here.",
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
      "No queue: jobs Linux can run wait for a Linux slot; what needs this Mac starts right away.",
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
    [linux, "Linux online · 1 of 2 running · CPU 12% · load 1.2 on 6 cores · 8.1 GB free"],
    [
      { ...linux, cpuPercent: null, load1: null, availableMemoryBytes: null },
      "Linux online · 1 of 2 running",
    ],
    [
      { ...linux, cpuCount: null },
      "Linux online · 1 of 2 running · CPU 12% · load 1.2 · 8.1 GB free",
    ],
    [{ ...linux, online: false, error: "Connection refused" }, "Linux offline: Connection refused"],
    [{ ...linux, online: false }, "Linux offline"],
    [
      { ...linux, online: false, status: "unresponsive", error: "banner exchange" },
      "Linux not responding, too loaded to answer: banner exchange",
    ],
    [
      { ...linux, status: "over-limit", overLimitBy: "memory stalled 57% of the time (limit 10%)" },
      "Linux online · 1 of 2 running · CPU 12% · load 1.2 on 6 cores · 8.1 GB free · over its limits: memory stalled 57% of the time (limit 10%)",
    ],
    // The line shows free memory itself: the limit names its threshold, one formatter for both.
    [
      {
        ...linux,
        availableMemoryBytes: 819 * 1024 ** 2,
        status: "over-limit",
        overLimitBy: "819 MB free, keeping 10%",
        overLimits: [
          { limit: "memory", value: 819 * 1024 ** 2, threshold: 10 },
          { limit: "swap", value: 0.2 * 1024 ** 3, threshold: 10, total: 4 * 1024 ** 3 },
        ],
      },
      "Linux online · 1 of 2 running · CPU 12% · load 1.2 on 6 cores · 819 MB free · over its limits: keeping 10% of memory free; swap nearly full: 205 MB of 4.0 GB free",
    ],
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
    // Run on Linux while it is offline is the "Wait for Linux" answer, so it stays.
    const offline = { ...state, linux: { ...linux, online: false } };
    expect(routeActions(entry(), offline).map((a) => a.runner)).toEqual(["mac", "linux"]);
  });

  it("an unconfirmed drop reruns only with a warning and force; its question's answer never forces", () => {
    const [mac, linux] = routeActions(entry({ unconfirmed: true }), state);
    expect(mac).toMatchObject({ force: true, confirm: expect.stringContaining("run it twice") });
    // On Linux the rerun never runs beside the earlier one.
    expect(linux).toMatchObject({
      force: true,
      confirm:
        "Linux hasn't confirmed the earlier run stopped. T3 stops it before this run starts there; if it can't, this run waits until the earlier one ends. Run it anyway?",
    });
    const ask = { reason: "dropped" as const, deadlineAt: "2026-01-01T00:00:00.000Z" };
    // Pinned or not, the question offers both places; Linux takes it once it confirms.
    for (const route of [undefined, "linux" as const]) {
      expect(
        askAnswers(entry({ unconfirmed: true, ask, ...(route ? { route } : {}) }), state),
      ).toEqual([
        { runner: "mac", label: "Run on this Mac", confirm: null, force: false },
        { runner: "linux", label: "Run on Linux", confirm: null, force: false },
      ]);
    }
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
    [
      "every job tied to this Mac (Mac-only, or its project's Runner off) moves nothing",
      { ...base, entries: [entry(), entry({ id: "b" })], macOnly: ["a", "b"] },
      [],
    ],
    [
      "one job that can go is enough",
      { ...base, entries: [entry(), entry({ id: "b" })], macOnly: ["a"] },
      ["Move all to Linux"],
    ],
    ["Linux offline takes nothing", { ...base, linux: { ...linux, online: false } }, []],
    ["Linux still being checked takes nothing", { ...base, linux: { ...linux, online: null } }, []],
    [
      "Linux offline still brings Linux waiters back",
      { ...base, linux: { ...linux, online: false }, routes: { a: "linux" } },
      ["Move all to this Mac"],
    ],
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
      "What a job does when the PC drops its run and its retries run out. A command Linux lacks a tool or folder for runs again on this Mac by itself.",
    ],
    [
      RUNNER_SETTING_COPY.runnerWhere.description,
      "This Mac keeps everything here. Mac first fills this Mac, then sends the rest to Linux. Hybrid splits jobs between both. Linux sends every job it can run there.",
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
    ["runnerLinuxFull", "linux", true],
    ["runnerLinuxFull", null, true],
    ["runnerLinuxFull", "automatic", false],
    ["runnerLinuxFull", "mac", false],
    ["runnerBringBack", "mac", true],
    ["runnerMacOnly", "linux", true],
  ] as const)("%s under %s: %s", (key, where, applies) => {
    expect(runnerModeFieldApplies(key, where)).toBe(applies);
  });

  it.each([
    ["runnerLinuxFull", "linux", null],
    ["runnerLinuxFull", null, null],
    ["runnerLinuxFull", "automatic", "Only applies when Where jobs run is Linux."],
    ["runnerMacFirstAfter", "linux", "Only applies when Where jobs run is Mac first."],
    ["runnerBringBack", "mac", null],
    ["runnerHost", "linux", null],
  ] as const)("why %s does nothing under %s: %s", (key, where, idle) => {
    expect(runnerModeFieldIdle(key, where)).toBe(idle);
  });

  it.each([
    ["linux", RUNNER_WHERE_DESCRIPTION.linux],
    ["automatic", RUNNER_WHERE_DESCRIPTION.automatic],
    [null, RUNNER_SETTING_COPY.runnerWhere.description],
  ] as const)("the Where line under %s", (where, line) => {
    expect(runnerWhereLine(where)).toBe(line);
  });
});

describe("When Linux is full", () => {
  it("offers every policy in the order the choice shows them, each with a line", () => {
    expect(Object.keys(RUNNER_LINUX_FULL_LABEL)).toEqual(RunnerLinuxFullPolicy.literals);
    expect(Object.keys(RUNNER_LINUX_FULL_DESCRIPTION)).toEqual(RunnerLinuxFullPolicy.literals);
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
    ["runnerMacOnly", { runnerWhere: "mac" }, null],
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
  const QUEUE_OFF =
    "Only applies while the heavy work queue is on or jobs run in Hybrid or Mac first.";
  const BOTH_OFF = "Only applies while the heavy work queue or the Runner is on.";
  const QUEUE_ONLY = "Only applies while the heavy work queue is on.";
  it.each([
    ["macCpuCeilingPercent", true, false, "mac", null],
    ["macCpuCeilingPercent", false, true, "automatic", null],
    ["macCpuCeilingPercent", false, true, null, null],
    ["macCpuCeilingPercent", false, null, "automatic", null],
    ["macCpuCeilingPercent", false, true, "macFirst", null],
    ["macCpuCeilingPercent", false, true, "linux", QUEUE_OFF],
    ["macMemoryFloorPercent", false, true, "mac", QUEUE_OFF],
    ["macMemoryFloorPercent", false, false, "automatic", QUEUE_OFF],
    ["heavyOverLimitSeconds", false, true, "linux", null],
    ["heavyOverLimitSeconds", true, false, "mac", null],
    ["heavyOverLimitSeconds", false, false, "automatic", BOTH_OFF],
    ["headPatienceMinutes", true, false, "mac", null],
    ["headPatienceMinutes", false, true, "automatic", QUEUE_ONLY],
    ["quickSeconds", false, true, "automatic", QUEUE_ONLY],
    ["quickSlots", false, true, "macFirst", QUEUE_ONLY],
    ["serviceIdleMinutes", false, null, null, QUEUE_ONLY],
    ["reclaimMinutes", false, false, "mac", QUEUE_ONLY],
  ] as const)(
    "%s with queue %s, Runner %s, %s",
    (key, queueEnabled, runnerEnabled, runnerWhere, idle) => {
      expect(heavyLimitIdle(key, { queueEnabled, runnerEnabled, runnerWhere })).toBe(idle);
    },
  );
});
