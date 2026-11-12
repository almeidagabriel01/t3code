import type { HeavyCommand, HeavyQueueEntry } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  dropTarget,
  formatDuration,
  heavyCommandKey,
  jobPriority,
  moveTarget,
  ordinal,
  peakUsageLine,
  heavyItemsInProject,
  projectForCommand,
  projectForCwd,
  queueSummary,
  usageLine,
  readableLabel,
  ruleForRoot,
} from "./heavyQueueModel.ts";

const e = (id: string, started = false): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label: id,
  cwd: "/",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: started ? "2026-01-01T00:00:01.000Z" : null,
});
const entries = [e("r", true), e("a"), e("b"), e("c"), e("d")];

describe("jobPriority", () => {
  // Agents' jobs wait "low" but run at normal QoS: only the applied QoS may label a running row.
  it.each([
    ["waiting agent job", { priority: "low" }, false, null, ["high-now"]],
    ["waiting user job", { priority: "normal" }, false, null, ["high-now"]],
    ["waiter already released", { priority: "high" }, false, null, []],
    ["running agent job at normal QoS", { priority: "low", qos: "normal" }, true, null, ["lower"]],
    [
      "running job lowered",
      { priority: "normal", qos: "background" },
      true,
      "Low priority",
      ["normal"],
    ],
    ["running where QoS cannot change", { priority: "low" }, true, null, []],
  ] as const)("%s", (_name, fields, started, label, changes) => {
    expect(jobPriority({ ...e("j", started), ...fields })).toEqual({ label, changes });
  });
});

describe("projectForCwd", () => {
  const projects = [
    { workspaceRoot: "/w/app" },
    { workspaceRoot: "/w/app/pkg/" },
    { workspaceRoot: "/w/other" },
  ];
  it.each([
    ["/w/app", "/w/app"],
    ["/w/app/src", "/w/app"],
    ["/w/app/pkg/x", "/w/app/pkg/"],
    ["/w/application", undefined],
    ["/elsewhere", undefined],
  ])("%s -> %s", (cwd, root) => {
    expect(projectForCwd(projects, cwd)?.workspaceRoot).toBe(root);
  });

  it("matches windows separators", () => {
    expect(projectForCwd([{ workspaceRoot: "C:\\w\\app" }], "C:\\w\\app\\src")).toBeDefined();
  });
});

describe("moveTarget and dropTarget", () => {
  it.each([
    ["b", "next", "a"],
    ["a", "next", undefined],
    ["c", "up", "b"],
    ["a", "up", undefined],
    ["b", "down", "d"],
    ["c", "down", null],
    ["d", "down", undefined],
    ["a", "end", null],
    ["d", "end", undefined],
    ["r", "end", undefined],
    ["zzz", "up", undefined],
  ] as const)("%s %s -> %s", (id, action, expected) => {
    expect(moveTarget(entries, id, action)).toBe(expected);
  });

  it.each([
    ["d", "b", "b"],
    ["a", "c", "d"],
    ["a", "d", null],
    ["b", "b", undefined],
    ["b", "r", undefined],
  ])("dropping %s on %s lands before %s", (id, over, expected) => {
    expect(dropTarget(entries, id, over)).toBe(expected);
  });
});

describe("usageLine", () => {
  const GB = 1024 ** 3;
  const machine = {
    busyCores: 1,
    cpuCount: 8,
    availableMemoryBytes: GB,
    totalMemoryBytes: 8 * GB,
    pressureLevel: null,
    swapInBytesPerSecond: null,
  };
  const run = { ...e("r", true), cpu: 2.04, memory: 3.25 * GB, peakCpu: 4, peakMemory: 5 * GB };
  const usual = (durationMs: number) => ({ b: { cpu: 3.96, memoryBytes: 2.5 * GB, durationMs } });
  it.each([
    [
      "current and peak with the share",
      run,
      { machine },
      "Using 2.0 cores (26%) · 3.3 GB · peak 4.0 cores · 5.0 GB",
    ],
    [
      "no share without a reading",
      run,
      { machine: null },
      "Using 2.0 cores · 3.3 GB · peak 4.0 cores · 5.0 GB",
    ],
    [
      "peak only when older",
      { ...e("r", true), peakCpu: 1, peakMemory: GB },
      { machine },
      "peak 1.0 cores · 1.0 GB",
    ],
    ["nothing before a sample", e("r", true), { machine }, null],
    [
      "megabytes below a gigabyte",
      { ...e("r", true), cpu: 0.6, memory: 32 * 1024 ** 2, peakCpu: 0.9, peakMemory: 1000 },
      { machine },
      "Using 0.6 cores (8%) · 32 MB · peak 0.9 cores · 1 MB",
    ],
    [
      "usual in seconds",
      e("b"),
      { machine, estimates: usual(45_000) },
      "Usually ~4.0 cores · 2.5 GB · 45s",
    ],
    [
      "usual in minutes",
      e("b"),
      { machine, estimates: usual(150_000) },
      "Usually ~4.0 cores · 2.5 GB · 3 min",
    ],
    [
      "usual in hours",
      e("b"),
      { machine, estimates: usual(5_400_000) },
      "Usually ~4.0 cores · 2.5 GB · 1.5 h",
    ],
    ["nothing without history", e("b"), { machine, estimates: {} }, null],
  ])("%s", (_name, entry, state, expected) => {
    expect(usageLine(entry, state)).toBe(expected);
  });
});

describe("summary and formatting", () => {
  const base = {
    entries,
    enabled: true,
    paused: false,
    maxRunning: 3,
    machine: null,
    hold: null,
    reasons: {},
    routes: {},
  };
  const machine = {
    busyCores: 0.9,
    cpuCount: 10,
    availableMemoryBytes: 3.2 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    pressureLevel: 2,
    swapInBytesPerSecond: 40 * 1024 ** 2,
  };
  const reading = " · CPU 9% · 3.2 GB free";
  it("reads the slots, pause and room", () => {
    expect(queueSummary(base)).toBe("1 of 3 running");
    expect(queueSummary({ ...base, paused: true })).toBe("1 of 3 running · paused");
    expect(queueSummary({ ...base, enabled: false, paused: true })).toBe(
      "Queue off: heavy jobs start right away",
    );
    expect(
      queueSummary({ ...base, machine: { ...machine, pressureLevel: 0, swapInBytesPerSecond: 0 } }),
    ).toBe(`1 of 3 running · Mac has room${reading}`);
  });

  // Each hold is worded from the reading printed beside it, never a generic "waiting for headroom".
  it.each([
    ["paused", machine, "paused"],
    ["exclusive", machine, "waiting: a job that runs alone is running"],
    ["runs-alone", machine, "waiting: the next job runs alone"],
    ["slots", machine, "waiting: all 3 slots busy"],
    ["settling", machine, "waiting: letting the last one ramp up"],
    ["no-reading", null, "waiting: no load reading yet"],
    ["pressure", machine, "waiting: memory pressure high"],
    ["pressure", { ...machine, pressureLevel: 4 }, "waiting: memory pressure critical"],
    ["swap-in", machine, "waiting: swapping 40 MB/s"],
    ["memory-floor", machine, "waiting: memory low"],
    ["cpu", machine, "waiting: CPU busy"],
    ["steadying", machine, "waiting: making sure the room lasts"],
    ["job-memory", machine, "waiting: needs ~4.0 GB; 3.2 GB free, 3.2 GB kept spare"],
    ["job-cpu", machine, "waiting: needs ~4.0 cores; CPU 9%, limit 70%"],
  ] as const)("says why it waits: %s", (hold, reading, text) => {
    const reasons = {
      a:
        hold === "job-cpu"
          ? "needs ~4.0 cores; CPU 9%, limit 70%"
          : "needs ~4.0 GB; 3.2 GB free, 3.2 GB kept spare",
    };
    const paused = hold === "paused";
    const numbers = reading === null ? "" : " · CPU 9% · 3.2 GB free";
    expect(queueSummary({ ...base, paused, machine: reading, hold, reasons })).toBe(
      `1 of 3 running · ${text}${numbers}`,
    );
  });

  it("names a limit without claiming anything waits when nothing does", () => {
    expect(queueSummary({ ...base, entries: [e("r", true)], machine, hold: "pressure" })).toBe(
      `1 of 3 running · memory pressure high${reading}`,
    );
  });

  // The slots and the hold are the Mac's: Linux jobs have their own line, and a job waiting for
  // a Linux slot is not held by the Mac's memory.
  it("counts and explains only the Mac's side when the Runner sends work to Linux", () => {
    const linux = { ...e("l", true), runner: "linux" as const };
    expect(
      queueSummary({
        ...base,
        entries: [e("r", true), linux, e("w")],
        routes: { w: "linux" },
        machine,
        hold: "pressure",
      }),
    ).toBe(`1 of 3 running · memory pressure high${reading}`);
  });

  it("finds a rule by folder ignoring trailing slashes", () => {
    expect(ruleForRoot([{ root: "/w/app", priority: "first" }], "/w/app/")?.priority).toBe("first");
    expect(ruleForRoot([], "/w")).toBeUndefined();
  });

  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [21, "21st"],
    [112, "112th"],
  ])("ordinal %i", (n, expected) => expect(ordinal(n)).toBe(expected));

  it("makes command labels readable and bounded", () => {
    expect(readableLabel("/tmp/scratch/gate.sh --all")).toBe("gate.sh --all");
    expect(readableLabel("pnpm test")).toBe("pnpm test");
    const long = readableLabel(`run ${"x".repeat(200)}`);
    expect(long).toHaveLength(90);
    expect(long.endsWith("…")).toBe(true);
  });

  it("formats elapsed time", () => {
    const now = Date.parse("2026-01-01T02:05:00.000Z");
    expect(formatDuration("2026-01-01T02:04:55.000Z", now)).toBe("5s");
    expect(formatDuration("2026-01-01T01:55:00.000Z", now)).toBe("10m");
    expect(formatDuration("2026-01-01T00:00:00.000Z", now)).toBe("2h 5m");
  });
});

describe("heavy commands", () => {
  const command = (over: Partial<HeavyCommand>): HeavyCommand => ({
    source: "agent",
    pid: 12,
    startTimeMs: 34,
    threadId: "t1",
    label: "vp test",
    name: "Tests",
    startedAt: "2026-01-01T00:00:00.000Z",
    stoppable: true,
    ...over,
  });
  const projects = [
    { id: "app", workspaceRoot: "/w/app" },
    { id: "api", workspaceRoot: "/w/api" },
  ];
  const threadProject = (threadId: string) => (threadId === "t1" ? "api" : undefined);

  it.each([
    { name: "a queue row by its folder", over: { cwd: "/w/app/src" }, expected: "app" },
    {
      name: "a folder outside every project falls back to the thread",
      over: { cwd: "/tmp" },
      expected: "api",
    },
    { name: "a direct command by its thread", over: {}, expected: "api" },
    { name: "an unknown thread", over: { threadId: "t9" }, expected: undefined },
    { name: "no thread and no folder", over: { threadId: null }, expected: undefined },
  ])("finds the project of $name", ({ over, expected }) => {
    expect(projectForCommand(command(over), projects, threadProject)?.id).toBe(expected);
  });

  it.each([
    {
      name: "keeps worktree jobs through their thread and nested projects by the deepest folder",
      projectId: "api",
      expected: ["worktree", "direct", "nested-api"],
    },
    { name: "keeps only the nested project's own folder", projectId: "app", expected: ["app"] },
    { name: "keeps nothing for a project with no jobs", projectId: "web", expected: [] },
  ])("$name", ({ projectId, expected }) => {
    const items = [
      { id: "worktree", cwd: "/home/.t3/worktrees/api-1", threadId: "t1" },
      { id: "direct", threadId: "t1" },
      { id: "nested-api", cwd: "/w/api/packages/x", threadId: null },
      { id: "app", cwd: "/w/api/apps/app/src", threadId: "t1" },
      { id: "orphan", cwd: "/tmp", threadId: null },
    ];
    const nested = [...projects, { id: "app", workspaceRoot: "/w/api/apps/app" }].filter(
      (project) => project.workspaceRoot !== "/w/app",
    );
    expect(
      heavyItemsInProject(items, {
        projectId,
        projects: nested,
        projectIdOfThread: threadProject,
      }).map((item) => item.id),
    ).toEqual(expected);
  });

  it("keys a queue row by its entry and a direct one by its process identity", () => {
    expect(heavyCommandKey(command({ entryId: "q1" }))).toBe("q1");
    expect(heavyCommandKey(command({}))).toBe("12:34");
  });
});

describe("peakUsageLine", () => {
  it.each([
    [{ peakCpu: 0.9, peakMemory: 40 * 1024 ** 2 }, "Peak 0.9 cores · 40 MB"],
    [{ peakCpu: 3, peakMemory: 2.4 * 1024 ** 3 }, "Peak 3.0 cores · 2.4 GB"],
    [{ cpu: 1, memory: 1 }, null],
  ])("formats %o", (usage, expected) => {
    expect(peakUsageLine(usage)).toBe(expected);
  });
});
