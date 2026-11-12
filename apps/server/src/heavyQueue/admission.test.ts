// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry } from "@t3tools/contracts";

import {
  estimate,
  kindOf,
  plan,
  signatureOf,
  workersFor,
  type PlanInput,
  type Run,
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
const base: Omit<PlanInput, "entries"> = {
  maxRunning: 3,
  enabled: true,
  paused: false,
  history: {},
  sample: calm,
  lastStartAt: null,
  holding: false,
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

  it("device opens held by a server are exclusive", () => {
    expect(kindOf({ label: "Open iPhone", server: true })).toBe("exclusive");
  });

  it("drops flags and paths so runs of one command share a signature", () => {
    expect(signatureOf("vp test run src/a.test.ts --watch")).toBe(
      signatureOf("vp test run src/b/c.test.ts"),
    );
    expect(signatureOf("vp test run src/a.test.ts")).toBe("vp test run");
  });

  it("estimates from the worst recent run and the median duration, else by kind", () => {
    const history = {
      "vp run build": [run(2, 3, 30_000), run(6, 5, 60_000), run(3, 4, 90_000)],
    };
    expect(estimate(history, { label: "vp run build" }, 10)).toEqual({
      cpu: 6,
      memoryBytes: 5 * GIB,
      durationMs: 60_000,
    });
    expect(estimate({}, { label: "vp run build" }, 10)).toMatchObject({
      cpu: 4,
      memoryBytes: 4 * GIB,
      durationMs: null,
    });
    expect(estimate({}, { label: "vp run typecheck" }, 1)).toMatchObject({ cpu: 1 });
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
      reason: { a: "paused" },
    },
    {
      name: "room on a calm machine: second job joins",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run build")],
      admit: "a",
    },
    {
      name: "kernel pressure level 2 holds a second job even with 29% free",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: {
        sample: { ...calm, availableMemoryBytes: 0.29 * 32 * GIB, pressureLevel: 2 },
      },
      admit: null,
      reason: { a: "waiting for memory: the system reports memory pressure" },
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
      reason: { a: "waiting for memory: swapping in 80 MB/s" },
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
      reason: { a: "waiting for steady headroom" },
    },
    {
      name: "pressure on the latest sample breaks the window",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { sample: { ...calm, headroomSince: null } },
      admit: null,
      reason: { a: "waiting for steady headroom" },
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
      reason: { a: "all 2 slots are busy" },
    },
    {
      name: "maxRunning 1 is strictly one at a time",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: { maxRunning: 1 },
      admit: null,
      reason: { a: "all 1 slots are busy" },
    },
    {
      name: "ramp-up: the last start has not settled",
      entries: [entry("r", "vp run build", 5_000), entry("a", "vp run typecheck")],
      change: { lastStartAt: NOW - 5_000 },
      admit: null,
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
      reason: { a: "waiting for a load reading" },
    },
    {
      name: "memory short for the predicted peak",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run build")],
      change: { sample: { ...calm, availableMemoryBytes: 9 * GIB } },
      admit: null,
      reasonStarts: { a: "waiting for room: needs ~4.0 GB" },
    },
    {
      name: "cpu short for the predicted peak",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run build")],
      change: { sample: { ...calm, busyCores: 8 } },
      admit: null,
      reasonStarts: { a: "waiting for room: needs ~4.0 cores" },
    },
    {
      name: "history lowers the prediction so a small job fits where the default would not",
      entries: [entry("r", "vp run build", 60_000), entry("a", "vp run typecheck")],
      change: {
        sample: { ...calm, availableMemoryBytes: 7.5 * GIB },
        history: { "vp run typecheck": [run(0.5, 0.3, 10_000)] },
      },
      admit: "a",
    },
    {
      name: "exclusive job waits until nothing runs",
      entries: [entry("r", "vp run build", 60_000), entry("a", "xcrun simctl boot x")],
      admit: null,
      reason: { a: "runs alone: waiting for the running ones to finish" },
    },
    {
      name: "nothing starts while an exclusive job runs",
      entries: [entry("r", "xcrun simctl boot x", 60_000), entry("a", "vp run typecheck")],
      admit: null,
      reason: { a: "an exclusive job is running alone" },
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
    },
    {
      name: "no backfill when the small job would outlast the wait",
      entries: [
        entry("r", "vp run build", 290_000),
        entry("head", "vp run build"),
        entry("small", "vp run typecheck"),
      ],
      change: {
        sample: { ...calm, availableMemoryBytes: 9 * GIB },
        history: {
          "vp run build": [run(2, 4, 300_000)],
          "vp run typecheck": [run(0.5, 0.3, 60_000)],
        },
      },
      admit: null,
    },
    {
      name: "no backfill when the running job's length is unknown",
      entries: [
        entry("r", "vp run build", 60_000),
        entry("head", "vp run build"),
        entry("small", "vp run typecheck"),
      ],
      change: {
        sample: { ...calm, availableMemoryBytes: 9 * GIB },
        history: { "vp run typecheck": [run(0.5, 0.3, 1_000)] },
      },
      admit: null,
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
    },
  ] as ReadonlyArray<{
    name: string;
    entries: ReadonlyArray<HeavyQueueEntry>;
    change?: Partial<Omit<PlanInput, "entries">>;
    admit: string | null;
    reason?: Record<string, string>;
    reasonStarts?: Record<string, string>;
  }>)("$name", ({ entries, change, admit, reason, reasonStarts }) => {
    const result = plan({ ...base, ...change, entries });
    expect(result.admit).toBe(admit);
    for (const [id, text] of Object.entries(reason ?? {})) expect(result.reasons[id]).toBe(text);
    for (const [id, text] of Object.entries(reasonStarts ?? {})) {
      expect(result.reasons[id]?.startsWith(text)).toBe(true);
    }
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
    expect(off).toEqual({ admit: "a", reasons: {}, room: true, holding: false });
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

  it("asks for a higher memory level to reopen after blocking, so admission does not flap", () => {
    const entries = [entry("r", "vp run build", 60_000), entry("a", "vp run build")];
    // 11.9 - 4 GiB sits above the 20% floor (6.4) but below the 25% reopen level (8).
    const tight = { ...calm, availableMemoryBytes: 11.9 * GIB };
    expect(plan({ ...base, entries, sample: tight, holding: false }).admit).toBe("a");
    expect(plan({ ...base, entries, sample: tight, holding: true }).admit).toBeNull();
    const blocked = plan({ ...base, entries, sample: { ...calm, availableMemoryBytes: 9 * GIB } });
    expect(blocked.holding).toBe(true);
    expect(blocked.room).toBe(false);
  });
});
