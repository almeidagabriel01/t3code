import {
  HEAVY_QUEUE_DEFAULTS,
  type HeavyCommand,
  type HeavyQueueEntry,
  type HeavyQueueState,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  dropTarget,
  formatDuration,
  formatFreeMemory,
  jobCost,
  orphanLine,
  heavyCommandKey,
  heavyWork,
  jobPriority,
  macNoteGauge,
  machineBar,
  macReading,
  machineSummaries,
  moveTarget,
  ordinal,
  heavyRowUsage,
  peakUsageLine,
  heavyItemsInProject,
  projectForCommand,
  projectForCwd,
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

  it("leaves an orphan out of the line: it never moves, and nothing lands next to it", () => {
    const withOrphan = [...entries, { ...e("o"), orphanedAt: 0 }];
    expect(moveTarget(withOrphan, "o", "next")).toBeUndefined();
    expect(moveTarget(withOrphan, "d", "end")).toBeUndefined();
    expect(dropTarget(withOrphan, "a", "o")).toBeUndefined();
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
    [
      "memory alone when the CPU was not read",
      { ...e("r", true), memory: 2.1 * GB, peakMemory: 2.4 * GB },
      { machine },
      "Using 2.1 GB · CPU unavailable · peak 2.4 GB",
    ],
    [
      "usual without cores when no run's CPU was read",
      e("b"),
      { machine, estimates: { b: { memoryBytes: 2.5 * GB, durationMs: 45_000 } } },
      "Usually ~2.5 GB · 45s",
    ],
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
  const mac = (state: Partial<Parameters<typeof machineSummaries>[0]>) =>
    machineSummaries({ ...base, ...state }).mac;
  it("reads the slots, pause, the queue being off and room", () => {
    expect(mac({})).toMatchObject({ running: 1, slots: 3, note: null, cpuPercent: null });
    expect(mac({ paused: true }).note).toBe("paused");
    expect(mac({ enabled: false, paused: true }).note).toBe(
      "Queue off: heavy jobs start right away",
    );
    expect(
      mac({ machine: { ...machine, pressureLevel: 0, swapInBytesPerSecond: 0 } }),
    ).toMatchObject({ note: null, cpuPercent: 9, freeBytes: machine.availableMemoryBytes });
  });

  // Each hold is worded from the reading shown beside it, never a generic "waiting for headroom".
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
    expect(mac({ paused: hold === "paused", machine: reading, hold, reasons }).note).toBe(text);
  });

  it("names a limit without claiming anything waits when nothing does", () => {
    expect(mac({ entries: [e("r", true)], machine, hold: "pressure" }).note).toBe(
      "memory pressure high",
    );
  });

  // The slots and the hold are the Mac's: Linux jobs count under Linux, and a job waiting for a
  // Linux slot is not held by the Mac's memory.
  it("counts and explains only the Mac's side when the Runner sends work to Linux", () => {
    const linux = { ...e("l", true), runner: "linux" as const };
    expect(
      mac({
        entries: [e("r", true), linux, e("w")],
        routes: { w: "linux" },
        machine,
        hold: "pressure",
      }),
    ).toMatchObject({ running: 1, slots: 3, note: "memory pressure high" });
  });

  const LINUX = {
    host: "remoto",
    online: true,
    slots: 2,
    running: 1,
    load1: 2,
    cpuCount: 6,
    availableMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
  };
  const healthyMac = {
    running: 1,
    slots: 3,
    cpuPercent: null,
    load: null,
    cpuCount: null,
    freeBytes: null,
    online: true,
    note: null,
  };
  it.each([
    ["no Runner", {}, healthyMac, null],
    [
      "a Mac reading",
      { machine },
      { ...healthyMac, cpuPercent: 9, cpuCount: 10, freeBytes: machine.availableMemoryBytes },
      null,
    ],
    [
      "the queue off",
      { enabled: false },
      { ...healthyMac, note: "Queue off: heavy jobs start right away" },
      null,
    ],
    [
      "a pause, which holds Linux too",
      { paused: true, linux: LINUX },
      { ...healthyMac, note: "paused" },
      {
        running: 1,
        slots: 2,
        cpuPercent: null,
        load: 2,
        cpuCount: 6,
        freeBytes: LINUX.availableMemoryBytes,
        online: true,
        note: "paused",
      },
    ],
    [
      "a hold with a waiter",
      { hold: "slots", linux: LINUX },
      { ...healthyMac, note: "waiting: all 3 slots busy" },
      {
        running: 1,
        slots: 2,
        cpuPercent: null,
        load: 2,
        cpuCount: 6,
        freeBytes: LINUX.availableMemoryBytes,
        online: true,
        note: null,
      },
    ],
    [
      "Linux offline",
      { linux: { ...LINUX, online: false, error: "ssh timed out" } },
      healthyMac,
      expect.objectContaining({ online: false, note: "Linux offline: ssh timed out" }),
    ],
    [
      "Linux not checked yet",
      { linux: { ...LINUX, online: null } },
      healthyMac,
      expect.objectContaining({ online: null, note: "Checking Linux (remoto)…" }),
    ],
  ] as const)("summarizes each machine with %s", (_name, over, mac, linux) => {
    expect(machineSummaries({ ...base, linux: null, ...over })).toEqual({ mac, linux });
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

  it.each([
    [3.44 * 1024 ** 3, "3.4 GB"],
    [420 * 1024 ** 2, "420 MB"],
    [1024, "1 MB"],
  ])("prints %d bytes free as %s", (bytes, text) => expect(formatFreeMemory(bytes)).toBe(text));

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

describe("heavyWork", () => {
  const LINUX = {
    host: "remoto",
    online: true,
    slots: 2,
    running: 2,
    load1: 1,
    cpuCount: 6,
    availableMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
  };
  const job = (id: string, over: Partial<HeavyQueueEntry> = {}) => ({
    ...e(id),
    pid: 100,
    ...over,
  });
  const cmd = (over: Partial<HeavyCommand>): HeavyCommand => ({
    source: "agent",
    pid: 7,
    startTimeMs: 1,
    threadId: "t1",
    label: "vp test",
    name: "Tests",
    startedAt: "2026-01-01T00:00:00.000Z",
    stoppable: true,
    ...over,
  });
  const STARTED = { startedAt: "2026-01-01T00:00:01.000Z" };
  const ids = (work: ReturnType<typeof heavyWork>) => ({
    mac: [...work.mac.running, ...work.mac.direct, ...work.mac.waiting].map((item) =>
      "id" in item ? item.id : `cmd:${item.pid}`,
    ),
    linux: [...work.linux.running, ...work.linux.waiting].map((item) => item.id),
    detached: work.detached.map((item) => `cmd:${item.pid}`),
  });

  it.each([
    {
      name: "a started entry repeated in the feed as a queue command shows once",
      entries: [job("q", { ...STARTED, pid: 30 })],
      commands: [cmd({ source: "queue", entryId: "q", pid: 30 })],
      expected: { mac: ["q"], linux: [], detached: [] },
    },
    {
      name: "a Linux job's queue command never lands under the Mac",
      entries: [job("l", { ...STARTED, runner: "linux", pid: 31 })],
      commands: [cmd({ source: "queue", entryId: "l", pid: 31 })],
      expected: { mac: [], linux: ["l"], detached: [] },
    },
    {
      name: "an orphan sits after every waiter, so their places stay as the queue counts them",
      entries: [job("o", { orphanedAt: 1 }), job("w1"), job("w2")],
      commands: [],
      expected: { mac: ["w1", "w2", "o"], linux: [], detached: [] },
    },
    {
      name: "a queue command whose entry already finished shows nothing",
      entries: [],
      commands: [cmd({ source: "queue", entryId: "gone", pid: 32 })],
      expected: { mac: [], linux: [], detached: [] },
    },
    {
      name: "a started entry the feed has not sampled yet still shows",
      entries: [job("new", { ...STARTED, pid: 33 })],
      commands: [],
      expected: { mac: ["new"], linux: [], detached: [] },
    },
    {
      name: "a direct command on a running entry's pid is that job, seen before the queue claimed it",
      entries: [job("q", { ...STARTED, pid: 34 })],
      commands: [cmd({ pid: 34 }), cmd({ source: "terminal", pid: 35 })],
      expected: { mac: ["q", "cmd:35"], linux: [], detached: [] },
    },
    {
      name: "a server-held job's pid (the server) never hides a direct command",
      entries: [job("s", { ...STARTED, pid: 7, server: true })],
      commands: [cmd({ pid: 7 })],
      expected: { mac: ["s", "cmd:7"], linux: [], detached: [] },
    },
    {
      name: "detached commands come back apart",
      entries: [],
      commands: [cmd({ source: "detached", threadId: null, pid: 36 })],
      expected: { mac: [], linux: [], detached: ["cmd:36"] },
    },
  ])("$name", ({ entries, commands, expected }) => {
    expect(ids(heavyWork({ entries, linux: LINUX, routes: {} }, commands))).toEqual(expected);
  });

  it("lists each machine running first, then its waiters in run order", () => {
    const work = heavyWork(
      {
        entries: [
          job("m1"),
          job("l1"),
          job("mrun", STARTED),
          job("m2"),
          job("lrun", { ...STARTED, runner: "linux" }),
        ],
        linux: LINUX,
        routes: { l1: "linux" },
      },
      [cmd({ pid: 9 })],
    );
    expect(ids(work)).toEqual({
      mac: ["mrun", "cmd:9", "m1", "m2"],
      linux: ["lrun", "l1"],
      detached: [],
    });
  });

  it("keeps a job still running on Linux there after the Runner went off", () => {
    const work = heavyWork(
      { entries: [job("l", { ...STARTED, runner: "linux" })], linux: null, routes: {} },
      [],
    );
    expect(work.mac.running).toEqual([]);
    expect(work.linux.running.map((entry) => entry.id)).toEqual(["l"]);
  });
});

describe("macNoteGauge", () => {
  it.each([
    [{ hold: "memory-floor" }, "memory"],
    [{ hold: "pressure" }, "memory"],
    [{ hold: "swap-in" }, "memory"],
    [{ hold: "job-memory" }, "memory"],
    [{ hold: "cpu" }, "cpu"],
    [{ hold: "job-cpu" }, "cpu"],
    [{ hold: "slots" }, null],
    [{ hold: "settling" }, null],
    [{ hold: null }, null],
    [{ hold: "cpu", paused: true }, null],
    [{ hold: "cpu", enabled: false }, null],
  ] as const)("puts %o on %s", (over, gauge) => {
    expect(macNoteGauge({ enabled: true, paused: false, ...over })).toBe(gauge);
  });
});

describe("jobCost and orphanLine", () => {
  it.each([
    ["quick", "staged files", "Quick"],
    ["standard", "first run", "Job"],
    ["service", "dev server", "Keeps running"],
  ] as const)("names the %s class %s", (cls, why, label) => {
    expect(jobCost({ costs: { a: { class: cls, why } } }, e("a"))).toEqual({
      class: cls,
      label,
      why,
    });
  });

  it("says nothing for a row the state has no class for", () => {
    expect(jobCost({}, e("a"))).toBeNull();
    expect(jobCost({ costs: {} }, e("a"))).toBeNull();
  });

  it.each([
    { name: "a fresh orphan has the whole window", at: 0, expected: "10 min left" },
    { name: "a part minute counts as one", at: 9 * 60_000 + 1, expected: "1 min left" },
    { name: "a late read never says zero", at: 11 * 60_000, expected: "1 min left" },
  ])("$name", ({ at, expected }) => {
    expect(orphanLine({ ...e("o"), orphanedAt: 0 }, 10, at)).toBe(
      `Waiting for the agent to ask again · ${expected}`,
    );
  });

  it("leaves any other row alone", () => {
    expect(orphanLine(e("w"), 10, 0)).toBeNull();
  });
});

describe("machineBar", () => {
  const GiB = 1024 ** 3;
  const LINUX = {
    host: "remoto",
    online: true,
    slots: 2,
    running: 0,
    load1: 3,
    cpuCount: 6,
    availableMemoryBytes: 8 * GiB,
    totalMemoryBytes: 16 * GiB,
  };
  const MACHINE = {
    busyCores: 2,
    cpuCount: 8,
    availableMemoryBytes: 4 * GiB,
    totalMemoryBytes: 16 * GiB,
    pressureLevel: null,
    swapInBytesPerSecond: null,
  };
  const state = (over: Partial<HeavyQueueState> = {}): HeavyQueueState => ({
    entries: [],
    enabled: true,
    paused: false,
    rules: [],
    maxRunning: 3,
    ...HEAVY_QUEUE_DEFAULTS,
    reasons: {},
    room: true,
    claudeHookInstalled: false,
    deviceIdleMinutes: 20,
    machine: MACHINE,
    hold: null,
    linux: null,
    macOnly: [],
    routes: {},
    ...over,
  });
  const linuxJob = (id: string) => ({ ...e(id, true), runner: "linux" as const });
  const HOST = {
    sampledAt: 0,
    cpuUtilization: 0.5,
    cpuCount: 10,
    availableMemoryBytes: 8 * GiB,
    totalMemoryBytes: 16 * GiB,
  };

  it("counts each machine's running jobs from the entries, not Linux's own heartbeat", () => {
    // The "0 of 3 running" bug: two jobs ran on Linux and none on the Mac.
    const bar = machineBar(
      state({
        entries: [linuxJob("a"), linuxJob("b"), e("c", true), e("w")],
        linux: { ...LINUX, running: 0 },
      }),
      null,
    );
    expect(bar.mac.slots).toEqual({ running: 1, slots: 3, hint: "1 of 3 running on this Mac" });
    expect(bar.linux?.slots).toEqual({ running: 2, slots: 2, hint: "2 of 2 running on Linux" });
  });

  it("counts quick jobs apart from the job slots, and only while one runs", () => {
    const costs = {
      q: { class: "quick" as const, why: "usually 4 s" },
      s: { class: "service" as const, why: "dev server" },
      // A hooked commit runs in its own slot, not a quick one.
      c: { class: "quick" as const, why: "staged files", commit: true },
    };
    const busy = state({
      entries: [e("q", true), e("s", true), e("j", true), e("c", true)],
      costs,
    });
    const bar = machineBar(busy, null).mac;
    expect(bar.slots).toMatchObject({ running: 1, slots: 3 });
    // The section header's "Mac n/m" reads the same count.
    expect(machineSummaries(busy).mac.running).toBe(1);
    expect(bar.quick).toEqual({
      running: 1,
      slots: 2,
      hint: "1 of 2 quick jobs running on this Mac",
    });
    expect(machineBar(state({ entries: [e("j", true)], costs }), null).mac.quick).toBeNull();
  });

  it("reads the Mac from the queue's sample, and the host only without one", () => {
    const sampled = machineBar(state(), null).mac;
    expect(sampled.cpu).toEqual({
      share: 0.25,
      value: "25%",
      warn: false,
      hint: "CPU 25% · 2.0 of 8 cores busy",
    });
    expect(sampled.memory).toEqual({
      share: 0.75,
      value: "4.0 GB",
      warn: false,
      hint: "4.0 GB free of 16.0 GB",
    });
    expect(machineBar(state({ machine: null }), HOST).mac.cpu).toMatchObject({
      value: "50%",
      hint: "CPU 50% · 10 cores",
    });
  });

  it.each([
    ["the queue's sample", MACHINE, HOST, { cpuPercent: 25, usedBytes: 12 * GiB }],
    ["the host without a sample", null, HOST, { cpuPercent: 50, usedBytes: 8 * GiB }],
    [
      "no CPU before the host's first window",
      null,
      { ...HOST, cpuUtilization: null },
      { cpuPercent: null, usedBytes: 8 * GiB },
    ],
    ["nothing without either", null, null, { cpuPercent: null, usedBytes: null }],
    [
      "no memory from a host without a total",
      null,
      { ...HOST, totalMemoryBytes: 0 },
      { cpuPercent: 50, usedBytes: null },
    ],
  ] as const)("macReading takes %s", (_case, machine, host, expected) => {
    expect(macReading(state({ machine }), host)).toEqual(expected);
  });

  it.each([
    [
      "while the first read is in flight",
      null,
      false,
      "No CPU reading yet",
      "No memory reading yet",
    ],
    ["after a failed read", null, true, "CPU reading failed", "Memory reading failed"],
    [
      "with no CPU window yet",
      { ...HOST, cpuUtilization: null },
      false,
      "No CPU reading yet",
      "8.0 GB free of 16.0 GB",
    ],
  ] as const)("without a queue sample, %s", (_case, host, failed, cpuHint, memoryHint) => {
    const { mac } = machineBar(state({ machine: null }), host, failed);
    expect(mac.cpu).toMatchObject({ value: "--", hint: cpuHint });
    expect(mac.memory?.hint).toBe(memoryHint);
  });

  it.each([
    ["memory-floor", false, true],
    ["cpu", true, false],
    ["slots", false, false],
  ] as const)("a %s hold warns on its own gauge only", (hold, cpu, memory) => {
    const { mac } = machineBar(state({ hold, entries: [e("w")] }), null);
    expect([mac.cpu?.warn, mac.memory?.warn]).toEqual([cpu, memory]);
    const note = machineSummaries(state({ hold, entries: [e("w")] })).mac.note!;
    const worded = [mac.cpu!.hint, mac.memory!.hint, mac.slots!.hint].filter((hint) =>
      hint.endsWith(` · ${note}`),
    );
    // The hold is worded once: on the gauge it is about, or on the slots when it is about them.
    expect(worded).toHaveLength(1);
  });

  it("has no slots while the queue is off, only its note", () => {
    const { mac } = machineBar(state({ enabled: false }), null);
    expect(mac.slots).toBeNull();
    expect(mac.queueOff).toBe("Queue off: heavy jobs start right away");
  });

  it.each([
    [true, null, "remoto · online"],
    [
      false,
      { text: "Offline", hint: "Linux offline: ssh timed out" },
      "Linux offline: ssh timed out",
    ],
    [null, { text: "Checking…", hint: "Checking Linux (remoto)…" }, "Checking Linux (remoto)…"],
  ] as const)("Linux online=%s shows gauges only while online", (online, offline, statusHint) => {
    const { linux } = machineBar(
      state({ linux: { ...LINUX, online, error: "ssh timed out" }, paused: true }),
      null,
    );
    expect(linux).toMatchObject({ online, offline, statusHint });
    expect(linux!.cpu === null).toBe(online !== true);
    expect(linux!.slots!.hint).toBe("0 of 2 running on Linux · paused");
  });

  it("reads Linux's load as a share of its cores", () => {
    const { linux } = machineBar(state({ linux: LINUX }), null);
    expect(linux!.cpu).toEqual({
      share: 0.5,
      value: "50%",
      warn: false,
      hint: "Load 3.0 on 6 cores",
    });
    expect(linux!.memory!.hint).toBe("8.0 GB free of 16.0 GB");
    const bare = machineBar(
      state({ linux: { ...LINUX, cpuCount: null, totalMemoryBytes: null } }),
      null,
    ).linux!;
    expect(bare.cpu).toMatchObject({ value: "--", hint: "Load 3.0" });
    expect(bare.memory).toMatchObject({ share: null, hint: "8.0 GB free" });
    const none = machineBar(
      state({ linux: { ...LINUX, load1: null, availableMemoryBytes: null } }),
      null,
    ).linux!;
    expect([none.cpu?.hint, none.memory?.hint]).toEqual([
      "No load reading yet",
      "No memory reading yet",
    ]);
  });
});

describe("peakUsageLine", () => {
  it.each([
    [{ peakCpu: 0.9, peakMemory: 40 * 1024 ** 2 }, "Peak 0.9 cores · 40 MB"],
    [{ peakCpu: 3, peakMemory: 2.4 * 1024 ** 3 }, "Peak 3.0 cores · 2.4 GB"],
    [{ cpu: 1, memory: 1 }, null],
    [{ peakMemory: 2.4 * 1024 ** 3 }, "Peak 2.4 GB"],
  ])("formats %o", (usage, expected) => {
    expect(peakUsageLine(usage)).toBe(expected);
  });
});

describe("heavyRowUsage", () => {
  it.each([
    [
      { cpu: 2, memory: 100 },
      { cpuPercent: 25, rssBytes: 100 },
    ],
    [{ memory: 100 }, { cpuPercent: null, rssBytes: 100 }],
    [{}, null],
  ])("reads %o on 8 cores", (usage, expected) => {
    expect(heavyRowUsage(usage, 8)).toEqual(expected);
  });
});
