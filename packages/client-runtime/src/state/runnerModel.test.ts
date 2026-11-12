import type { HeavyQueueEntry, HeavyRunnerLinux } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  askRemaining,
  heavyModeLine,
  linuxLine,
  routeActions,
  runnerBadge,
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
    where: "mac" | "linux" | "automatic",
  ) => heavyModeLine({ queueEnabled, queuePaused, runnerEnabled, where, overflow: 3 });

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
      "Heavy jobs queue on this Mac; past 3 jobs, listed commands go to Linux.",
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
      "No queue: jobs start here right away until 3 jobs run, then listed commands go to Linux.",
    ],
  ] as const)("queue %s paused %s Runner %s %s", (queue, paused, runner, where, text) => {
    expect(line(queue, paused, runner, where)).toBe(text);
  });

  it("says one job, not one jobs", () => {
    expect(
      heavyModeLine({
        queueEnabled: true,
        queuePaused: false,
        runnerEnabled: true,
        where: "automatic",
        overflow: 1,
      }),
    ).toContain("past 1 job,");
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
      { runner: "linux", label: "Linux · Installing deps" },
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
