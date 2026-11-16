// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";
import { HEAVY_QUEUE_DEFAULTS, type HeavyQueueEntry } from "@t3tools/contracts";

import {
  estimate,
  kindOf,
  machineHold,
  plan,
  signatureOf,
  sustain,
  workersFor,
  type PlanInput,
  type Run,
  type Sustained,
} from "./admission.ts";

const GIB = 1024 ** 3;
const NOW = Date.parse("2026-01-01T01:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const entry = (id: string, label: string, startedMsAgo: number | null = null, waitedMs = 1000) =>
  ({
    id,
    pid: 1,
    threadId: null,
    label,
    cwd: "/",
    createdAt: at(waitedMs + (startedMsAgo ?? 0)),
    startedAt: startedMsAgo === null ? null : at(startedMsAgo),
  }) satisfies HeavyQueueEntry;

const calm = {
  at: NOW - 1000,
  busyCores: 1,
  cpuCount: 10,
  availableMemoryBytes: 20 * GIB,
  totalMemoryBytes: 32 * GIB,
  headroomSince: NOW - 10_000,
};
/** The live Mac: 16 GB with 28% free and the CPU quiet. */
const sixteen = {
  ...calm,
  availableMemoryBytes: 0.28 * 16 * GIB,
  totalMemoryBytes: 16 * GIB,
  pressureLevel: 1,
};
const base: Omit<PlanInput, "entries"> = {
  maxRunning: 3,
  enabled: true,
  paused: false,
  history: {},
  sample: calm,
  lastStartAt: null,
  holding: false,
  ...HEAVY_QUEUE_DEFAULTS,
  now: NOW,
};
const run = (cpu: number, memGb: number, durationMs: number): Run => ({
  cpu,
  memoryBytes: memGb * GIB,
  durationMs,
});

describe("command kinds and signatures", () => {
  it.each([
    ["vp run build", "heavy"],
    ["vp test run", "heavy"],
    ["pnpm playwright test", "heavy"],
    ["some-unknown-script.sh arg", "heavy"],
    ["vp run typecheck", "medium"],
    ["vp test run src/a.test.ts", "medium"],
    ["vp run check:changed", "medium"],
    ["xcrun simctl boot iPhone", "exclusive"],
    ["vp run dev:desktop", "exclusive"],
  ])("%s is %s", (label, kind) => {
    expect(kindOf({ label })).toBe(kind);
  });

  // The label is the first 200 characters of the line; the work can sit past it.
  it.each([
    ["xcrun simctl boot iPhone", "exclusive"],
    ["vp run typecheck", "medium"],
  ])("a long line is judged by its full text: %s is %s", (tail, kind) => {
    const line = `cd /w && cat > x.md <<'EOF'\n${"x".repeat(220)}\nEOF\n${tail}`;
    expect(kindOf({ label: line.slice(0, 200), line })).toBe(kind);
  });

  it("device opens held by a server are exclusive", () => {
    expect(kindOf({ label: "Open iPhone", server: true })).toBe("exclusive");
  });

  it("keeps a test run's target, so one file never shares the suite's runs", () => {
    expect(signatureOf("vp test run src/a.test.ts --watch")).toBe(
      signatureOf("cd /w && vp test run src/a.test.ts"),
    );
    expect(signatureOf("vp test run src/a.test.ts")).toBe("vp test run src/a.test.ts");
    // Any worktree, folder or redirection: the same file is the same command.
    expect(
      signatureOf("cd /w/x-1/apps/server && vp test run /w/x-1/apps/server/src/a.test.ts 2>&1"),
    ).toBe("vp test run src/a.test.ts");
    expect(signatureOf('vp test run src/a.test.ts > "$S/out.txt"')).toBe(
      "vp test run src/a.test.ts",
    );
    // Only a test run's target counts: every commit of other files is one command.
    expect(signatureOf("git commit apps/a.ts apps/b.ts")).toBe(signatureOf("git commit apps/c.ts"));
    expect(signatureOf("vp test run src/a.test.ts")).not.toBe(signatureOf("vp test run"));
    expect(signatureOf("vp test run src/a.test.ts")).not.toBe(
      signatureOf("vp test run src/b/c.test.ts"),
    );
  });

  it("estimates from the median run and the most CPU, else by kind; unread CPU never counts", () => {
    const history = {
      "vp run build": [run(2, 3, 30_000), run(6, 5, 60_000), run(3, 4, 90_000)],
    };
    expect(estimate(history, { label: "vp run build" }, 10, HEAVY_QUEUE_DEFAULTS)).toEqual({
      cpu: 6,
      memoryBytes: 4 * GIB,
      durationMs: 60_000,
    });
    expect(estimate({}, { label: "vp run build" }, 10, HEAVY_QUEUE_DEFAULTS)).toMatchObject({
      cpu: 4,
      memoryBytes: 1.5 * GIB,
      durationMs: null,
    });
    expect(estimate({}, { label: "vp run typecheck" }, 10, HEAVY_QUEUE_DEFAULTS)).toMatchObject({
      memoryBytes: 0.5 * GIB,
    });
    expect(estimate({}, { label: "vp run typecheck" }, 1, HEAVY_QUEUE_DEFAULTS)).toMatchObject({
      cpu: 1,
    });
    // A run whose CPU was never read (absent, or 0 in older files) teaches memory and time only.
    const unread = { memoryBytes: 2 * GIB, durationMs: 40_000 };
    expect(
      estimate(
        { "vp run build": [unread, run(0, 1, 20_000)] },
        { label: "vp run build" },
        10,
        HEAVY_QUEUE_DEFAULTS,
      ),
    ).toMatchObject({ cpu: 4, memoryBytes: 2 * GIB });
    expect(
      estimate(
        { "vp run build": [unread, run(3, 1, 20_000)] },
        { label: "vp run build" },
        10,
        HEAVY_QUEUE_DEFAULTS,
      ).cpu,
    ).toBe(3);
  });
});

describe("workers per job", () => {
  it.each([
    { cpuCount: 10, busy: 0.4, workers: 9, why: "idle: all but one core" },
    { cpuCount: 10, busy: null, workers: 9, why: "no reading: as if idle" },
    { cpuCount: 10, busy: 5.5, workers: 4, why: "the cores free now" },
    { cpuCount: 10, busy: 9.8, workers: 2, why: "never below two" },
    { cpuCount: 2, busy: 0, workers: 2, why: "two-core machine" },
  ])("$why", ({ cpuCount, busy, workers }) => {
    expect(workersFor(cpuCount, busy)).toBe(workers);
  });
});

describe("admission plan", () => {
  it.each([
    {
      name: "empty queue",
      entries: [],
      admit: null,
    },
    {
      name: "nothing running: the head starts even without a reading",
      entries: [entry("a", "vp run build"), entry("b", "vp run build")],
      change: { sample: null },
      admit: "a",
    },
    {
      name: "paused holds everyone, even with nothing running",
      entries: [entry("a", "vp run build")],
      change: { paused: true },
      admit: null,
      hold: "paused",
      reason: { a: "paused" },
    },
    {
      name: "room on a calm machine: second job joins",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run build")],
      admit: "a",
    },
    {
      name: "kernel pressure level 2 holds a job never seen (not known to be light) even with 29% free",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: {
        sample: { ...calm, availableMemoryBytes: 0.29 * 32 * GIB, pressureLevel: 2 },
      },
      admit: null,
      hold: "pressure",
      reason: { a: "memory pressure high" },
    },
    {
      name: "sustained swap-in holds a second job even with 29% free",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: {
        sample: {
          ...calm,
          availableMemoryBytes: 0.29 * 32 * GIB,
          pressureLevel: 1,
          swapInBytesPerSecond: 80 * 1024 ** 2,
        },
      },
      admit: null,
      hold: "swap-in",
      reason: { a: "swapping 80 MB/s" },
    },
    {
      name: "under pressure with nothing running, the head still runs alone",
      entries: [entry("a", "vp run build"), entry("b", "vp run build")],
      change: { sample: { ...calm, pressureLevel: 4 } },
      admit: "a",
    },
    {
      name: "headroom has not held long enough yet",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { sample: { ...calm, headroomSince: NOW - 2_000 } },
      admit: null,
      hold: "steadying",
      reason: { a: "making sure the room lasts" },
    },
    {
      name: "pressure on the latest sample breaks the window",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { sample: { ...calm, headroomSince: null } },
      admit: null,
      hold: "steadying",
      reason: { a: "making sure the room lasts" },
    },
    {
      name: "all slots busy",
      entries: [
        entry("r1", "vp run build", 60_000),
        entry("r2", "vp run build", 60_000),
        entry("a", "vp run typecheck"),
      ],
      change: { maxRunning: 2 },
      admit: null,
      hold: "slots",
      reason: { a: "all 2 slots busy" },
    },
    {
      name: "maxRunning 1 is strictly one at a time",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { maxRunning: 1 },
      admit: null,
      hold: "slots",
      reason: { a: "the one slot is busy" },
    },
    {
      name: "ramp-up: the last start has not settled",
      entries: [entry("r", "vp run build", 5_000), entry("a", "vp run typecheck")],
      change: { lastStartAt: NOW - 5_000 },
      admit: null,
      hold: "settling",
      reason: { a: "letting the last one ramp up" },
    },
    {
      name: "ramp-up over: admit again",
      entries: [entry("r", "vp run build", 30_000), entry("a", "vp run typecheck")],
      change: { lastStartAt: NOW - 30_000 },
      admit: "a",
    },
    {
      name: "stale reading: stay at one",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { sample: { ...calm, at: NOW - 60_000 } },
      admit: null,
      hold: "no-reading",
      reason: { a: "no load reading yet" },
    },
    {
      name: "memory short for the usual run",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run build")],
      change: {
        sample: { ...calm, availableMemoryBytes: 9 * GIB },
        history: { "vp run build": [run(2, 4, 60_000)] },
      },
      admit: null,
      hold: "job-memory",
      reason: { a: "needs ~4.0 GB; 9.0 GB free, 6.4 GB kept spare" },
    },
    {
      name: "memory below the floor holds whatever the job needs",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { sample: { ...calm, availableMemoryBytes: 5 * GIB } },
      admit: null,
      hold: "memory-floor",
      reason: { a: "memory low" },
    },
    {
      name: "CPU over the ceiling holds whatever the job needs",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { sample: { ...calm, busyCores: 8 } },
      admit: null,
      hold: "cpu",
      reason: { a: "CPU busy" },
    },
    {
      name: "cpu short for the predicted peak",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run build")],
      change: { sample: { ...calm, busyCores: 5 } },
      admit: null,
      hold: "job-cpu",
      reason: { a: "needs ~4.0 cores; CPU 50%, limit 70%" },
    },
    {
      name: "history lowers the prediction so a small job fits where the default would not",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run bundle")],
      change: {
        sample: { ...calm, availableMemoryBytes: 7.5 * GIB },
        history: { "vp run bundle": [run(0.5, 0.3, 10_000)] },
      },
      admit: "a",
    },
    {
      name: "exclusive job waits until nothing runs",
      entries: [entry("r", "vp run build", 60_000), entry("a", "xcrun simctl boot x")],
      admit: null,
      hold: "runs-alone",
      reason: { a: "the next job runs alone" },
    },
    {
      name: "nothing starts while an exclusive job runs",
      entries: [entry("r", "xcrun simctl boot x", 60_000), entry("a", "vp run typecheck")],
      admit: null,
      hold: "exclusive",
      reason: { a: "a job that runs alone is running" },
    },
    {
      name: "exclusive head with nothing running starts",
      entries: [entry("a", "xcrun simctl boot x"), entry("b", "vp run typecheck")],
      admit: "a",
    },
    {
      name: "backfill: a short job passes a head that does not fit and ends before room appears",
      entries: [
        entry("r", "vp run build", 60_000),
        entry("head", "vp run build"),
        entry("small", "vp run typecheck"),
      ],
      change: {
        sample: { ...calm, availableMemoryBytes: 9 * GIB },
        history: {
          "vp run build": [run(2, 4, 300_000)],
          "vp run typecheck": [run(0.5, 0.3, 20_000)],
        },
      },
      admit: "small",
      hold: "job-memory",
    },
    {
      name: "a job without history passes a head that does not fit, whatever anyone's length",
      entries: [
        entry("r", "vp run build", 60_000),
        entry("head", "vp run build"),
        entry("mid", "vp run build"),
        entry("small", "vp run typecheck"),
      ],
      change: {
        sample: { ...calm, availableMemoryBytes: 9 * GIB },
        history: { "vp run build": [run(2, 4, 300_000)] },
      },
      admit: "small",
      hold: "job-memory",
      reason: {
        head: "needs ~4.0 GB; 9.0 GB free, 6.4 GB kept spare",
        mid: "needs ~4.0 GB; 9.0 GB free, 6.4 GB kept spare",
      },
    },
    {
      name: "28% free on 16 GB: a test that usually stays small starts beside a running one",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp test run x.test.ts")],
      change: {
        sample: sixteen,
        history: {
          "vp test run x.test.ts": [run(1, 0.06, 5_000), run(1, 0.2, 5_000), run(1, 3.1, 5_000)],
        },
      },
      admit: "a",
    },
    {
      name: "28% free on 16 GB: a medium job never seen starts on the smaller guess",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { sample: sixteen },
      admit: "a",
    },
    {
      name: "under pressure a light job behind a heavy head starts; the head keeps waiting",
      entries: [
        entry("r", "vp run build", 60_000),
        entry("head", "vp run build"),
        entry("light", "vp run lint"),
      ],
      change: {
        sample: { ...sixteen, pressureLevel: 2 },
        history: { "vp run lint": [run(0.5, 0.1, 5_000)] },
      },
      admit: "light",
      hold: "pressure",
      reason: { head: "memory pressure high" },
    },
    {
      name: "critical memory pressure holds even a light job",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run lint")],
      change: {
        sample: { ...sixteen, pressureLevel: 4 },
        history: { "vp run lint": [run(0.5, 0.1, 5_000)] },
      },
      admit: null,
      hold: "pressure",
      reason: { a: "memory pressure critical" },
    },
    {
      name: "a 256 MB light limit holds a job that usually uses 400 MB under pressure",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run lint")],
      change: {
        sample: { ...sixteen, pressureLevel: 2 },
        history: { "vp run lint": [run(0.5, 400 / 1024, 5_000)] },
        lightJobMegabytes: 256,
      },
      admit: null,
      hold: "pressure",
    },
    {
      name: "28% free on 16 GB: a 4 GB guess holds a medium job never seen",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { sample: sixteen, unseenMediumMegabytes: 4096 },
      admit: null,
      hold: "job-memory",
    },
    {
      name: "30 minutes of patience: a head that waited 10 still lets a small job pass",
      entries: [
        entry("r", "vp run build", 60_000),
        entry("head", "vp run build", null, 10 * 60_000),
        entry("small", "vp run typecheck"),
      ],
      change: {
        sample: { ...calm, availableMemoryBytes: 9 * GIB },
        history: {
          "vp run build": [run(2, 4, 300_000)],
          "vp run typecheck": [run(0.5, 0.3, 1_000)],
        },
        headPatienceMinutes: 30,
      },
      admit: "small",
      hold: "job-memory",
    },
    {
      name: "a busy CPU holds even a light job",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run lint")],
      change: {
        sample: { ...sixteen, busyCores: 9.5 },
        history: { "vp run lint": [run(0.5, 0.1, 5_000)] },
      },
      admit: null,
      hold: "cpu",
    },
    {
      name: "aging: a head that waited long stops all backfill",
      entries: [
        entry("r", "vp run build", 60_000),
        entry("head", "vp run build", null, 10 * 60_000),
        entry("small", "vp run typecheck"),
      ],
      change: {
        sample: { ...calm, availableMemoryBytes: 9 * GIB },
        history: {
          "vp run build": [run(2, 4, 300_000)],
          "vp run typecheck": [run(0.5, 0.3, 1_000)],
        },
      },
      admit: null,
      hold: "job-memory",
    },
  ] as ReadonlyArray<{
    name: string;
    entries: ReadonlyArray<HeavyQueueEntry>;
    change?: Partial<Omit<PlanInput, "entries">>;
    admit: string | null;
    hold?: string;
    reason?: Record<string, string>;
  }>)("$name", ({ entries, change, admit, hold, reason }) => {
    const result = plan({ ...base, ...change, entries });
    expect(result.admit).toBe(admit);
    // Every held case names its enumerable reason; an admitted head has none.
    expect(result.hold).toBe(hold ?? null);
    for (const [id, text] of Object.entries(reason ?? {})) expect(result.reasons[id]).toBe(text);
  });

  const forced = (id: string, label: string) => ({ ...entry(id, label), forced: true });
  const full = [
    entry("r1", "vp run build", 60_000),
    entry("r2", "vp run build", 60_000),
    entry("r3", "vp run build", 60_000),
  ];

  it.each([
    { name: "paused", change: { paused: true }, entries: [] },
    { name: "every slot busy", change: {}, entries: full },
    {
      name: "no headroom",
      change: { sample: { ...calm, headroomSince: null, availableMemoryBytes: GIB } },
      entries: [entry("r1", "vp run build", 60_000)],
    },
    { name: "no load reading", change: { sample: null }, entries: full },
    {
      name: "an exclusive job running",
      change: {},
      entries: [entry("r1", "xcrun simctl boot x", 60_000)],
    },
    {
      name: "a start moments ago",
      change: { lastStartAt: NOW - 1_000, holding: true },
      entries: [entry("r1", "vp run build", 1_000)],
    },
  ])("switched off, holds no waiter despite $name", ({ change, entries }) => {
    const waiters = [entry("a", "xcrun simctl boot y"), entry("b", "vp run build")];
    const off = plan({ ...base, ...change, enabled: false, entries: [...entries, ...waiters] });
    expect(off).toEqual({ admit: "a", reasons: {}, room: true, holding: false, hold: null });
    const on = plan({ ...base, ...change, entries: [...entries, ...waiters] });
    expect(on.admit).toBeNull();
    expect(Object.keys(on.reasons)).toEqual(["a", "b"]);
  });
  it.each([
    { name: "paused", change: { paused: true }, entries: [] },
    { name: "every slot busy", change: {}, entries: full },
    {
      name: "no headroom",
      change: { sample: { ...calm, headroomSince: null, availableMemoryBytes: GIB } },
      entries: [entry("r1", "vp run build", 60_000)],
    },
    {
      name: "no load reading",
      change: { sample: null },
      entries: [entry("r1", "vp run build", 60_000)],
    },
    {
      name: "an exclusive job running",
      change: {},
      entries: [entry("r1", "xcrun simctl boot x", 60_000)],
    },
  ])(
    "admits a forced waiter despite $name, but still holds a normal one",
    ({ change, entries }) => {
      const waiters = [entry("n", "vp run build"), forced("f", "vp run build")];
      const result = plan({ ...base, ...change, entries: [...entries, ...waiters] });
      expect(result.admit).toBe("f");
      expect(result.reasons["n"]).toBeDefined();
      const held = plan({ ...base, ...change, entries: [...entries, entry("n", "vp run build")] });
      expect(held.admit).toBeNull();
    },
  );

  it("admits forced waiters one per plan call, in queue order", () => {
    const entries = [
      ...full,
      entry("n", "vp run build"),
      forced("f2", "vp run build"),
      forced("f1", "vp run build"),
    ];
    expect(plan({ ...base, paused: true, entries }).admit).toBe("f2");
    const afterFirst = entries.map((e) => (e.id === "f2" ? { ...e, startedAt: at(0) } : e));
    const reordered = [
      ...afterFirst.filter((e) => e.startedAt !== null),
      ...afterFirst.filter((e) => e.startedAt === null),
    ];
    expect(plan({ ...base, paused: true, entries: reordered }).admit).toBe("f1");
  });

  it("asks for a higher memory level to reopen after pressure, so admission does not flap", () => {
    const entries = [entry("r", "vp run build", 60_000), entry("a", "vp run build")];
    const history = { "vp run build": [run(2, 4, 60_000)] };
    // 11.9 - 4 GiB sits above the 20% floor (6.4) but below the 25% reopen level (8).
    const tight = { ...calm, availableMemoryBytes: 11.9 * GIB };
    expect(plan({ ...base, history, entries, sample: tight, holding: false }).admit).toBe("a");
    expect(plan({ ...base, history, entries, sample: tight, holding: true }).admit).toBeNull();
    const pressed = plan({ ...base, history, entries, sample: { ...calm, pressureLevel: 2 } });
    expect(pressed).toMatchObject({ holding: true, room: false });
    // A job too big to fit raises nothing, so a small one behind it still passes next time.
    const big = plan({
      ...base,
      history,
      entries,
      sample: { ...calm, availableMemoryBytes: 9 * GIB },
    });
    expect(big).toMatchObject({ holding: false, room: false, hold: "job-memory" });
  });

  it("28% free on 16 GB: a small job keeps passing a head too big to fit, plan after plan", () => {
    const entries = [
      entry("r", "vp run build", 60_000),
      entry("big", "vp run build"),
      entry("small", "vp run typecheck"),
    ];
    const history = { "vp run build": [run(2, 4, 60_000)] };
    const first = plan({ ...base, history, entries, sample: sixteen });
    expect(first.admit).toBe("small");
    // Each waiter plans again under the lock with what the last plan stored.
    expect(plan({ ...base, history, entries, sample: sixteen, holding: first.holding }).admit).toBe(
      "small",
    );
  });
});

describe("the Mac's limits are settings", () => {
  const limits = (macMemoryFloorPercent: number, macCpuCeilingPercent: number) => ({
    macMemoryFloorPercent,
    macCpuCeilingPercent,
  });

  it.each([
    // 8 of 32 GiB free is 25%; 4 of 10 cores busy is 40%.
    [limits(20, 70), null],
    [limits(30, 70), "memory-floor"],
    [limits(20, 35), "cpu"],
    [limits(5, 100), null],
  ] as const)("%o holds %s", (limit, hold) => {
    const sample = { ...calm, availableMemoryBytes: 8 * GIB, busyCores: 4 };
    expect(machineHold(sample, limit)).toBe(hold);
    const entries = [entry("r", "vp run typecheck", 60_000), entry("a", "vp run typecheck")];
    expect(plan({ ...base, ...limit, entries, sample }).hold).toBe(hold);
  });

  it("reopens five points past a configured floor and names the configured CPU limit", () => {
    const entries = [entry("r", "vp run build", 60_000), entry("a", "vp run build")];
    // 15.9 - 4 GiB is 37% of 32: above a 35% floor, below its 40% reopen point.
    const tight = { ...calm, availableMemoryBytes: 15.9 * GIB };
    const floor = {
      ...base,
      history: { "vp run build": [run(2, 4, 60_000)] },
      macMemoryFloorPercent: 35,
      entries,
      sample: tight,
    };
    expect(plan(floor).admit).toBe("a");
    expect(plan({ ...floor, holding: true }).hold).toBe("job-memory");
    const busy = plan({
      ...base,
      macCpuCeilingPercent: 40,
      entries,
      sample: { ...calm, busyCores: 1 },
    });
    expect(busy.reasons.a).toBe("needs ~4.0 cores; CPU 10%, limit 40%");
  });
});

describe("limits judged on sustained readings", () => {
  const WINDOW = 20_000;
  /** Folds readings `[secondsIn, over]` and returns the verdict after each. */
  const verdicts = (readings: ReadonlyArray<readonly [number, boolean]>) => {
    let state: Sustained | null = null;
    return readings.map(([seconds, over]) => {
      state = sustain(state, over, seconds * 1000, WINDOW);
      return state.overLimit;
    });
  };

  it.each([
    [
      "a spike shorter than the window stays put",
      [
        [0, false],
        [2, true],
        [4, true],
        [6, false],
      ],
      [false, false, false, false],
    ],
    [
      "a sustained overload moves once it fills the window",
      [
        [0, true],
        [10, true],
        [20, true],
        [30, true],
      ],
      [false, false, true, true],
    ],
    [
      "a dip inside the overload restarts its run",
      [
        [0, true],
        [10, false],
        [20, true],
        [30, true],
        [40, true],
      ],
      [false, false, false, false, true],
    ],
    [
      "back under for less than the window stays over",
      [
        [0, true],
        [20, true],
        [22, false],
        [30, false],
      ],
      [false, true, true, true],
    ],
    [
      "recovers once under for the whole window",
      [
        [0, true],
        [20, true],
        [22, false],
        [42, false],
      ],
      [false, true, true, false],
    ],
    [
      "a spike while recovering restarts the recovery",
      [
        [0, true],
        [20, true],
        [22, false],
        [30, true],
        [32, false],
        [52, false],
      ],
      [false, true, true, true, true, false],
    ],
  ] as const)("%s", (_name, readings, expected) => {
    expect(verdicts(readings)).toEqual(expected);
  });

  it("starts from room after a gap and from old files without the fields", () => {
    expect(sustain(null, true, 0, WINDOW)).toEqual({
      overLimit: false,
      overLimitSince: 0,
      underLimitSince: null,
    });
    expect(sustain({}, false, 5, WINDOW)).toEqual({
      overLimit: false,
      overLimitSince: null,
      underLimitSince: 5,
    });
  });
});
