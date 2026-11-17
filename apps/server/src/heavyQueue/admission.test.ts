// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";
import { HEAVY_QUEUE_DEFAULTS, type HeavyQueueEntry } from "@t3tools/contracts";

import {
  estimate,
  laneOf,
  machineHold,
  plan,
  QUICK_SLOTS,
  signatureOf,
  sustain,
  workersFor,
  type PlanInput,
  type Run,
  type Sustained,
} from "./admission.ts";
import { kindOf } from "./commandShapes.ts";

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
    ["vp run dev:desktop", "heavy"],
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

  // Keys the old signature learned in the incident (`vp fmt $=files 2>`, `git commit "feat`).
  it.each([
    [`files=(a.ts b.ts); vp fmt "$@" "\${files[@]}" 2>/dev/null`, "vp fmt"],
    [`vp fmt --stdin-filepath="$f" < "$f" 2>&1 | diff -q - "$f"`, "vp fmt files"],
    ["pnpm exec vp fmt apps/a.ts apps/b.ts", "vp fmt files"],
    ["vp lint --no-ignore a.ts b.ts c.ts", "vp lint files"],
    [`git commit -m "feat: x" a.ts 2>&1 | tail -8; git log --oneline -2`, "git commit"],
    [`git commit -q -m "runex fix" apps/a.ts`, "git commit"],
    ["pnpm --filter web run build", "pnpm web run build"],
    ["cd apps/server && vp run typecheck 2>&1 | tail -20", "vp run typecheck"],
    ["npx vitest run src/a.test.ts", "vitest run src/a.test.ts"],
    ["vp lint a.ts && vp run dev", "vp lint files && vp run dev"],
    [`bash -c 'cd /w && vp run typecheck'`, "vp run typecheck"],
  ])("keys %s by its work, not its arguments", (line, signature) => {
    expect(signatureOf(line)).toBe(signature);
  });

  it("keys a line by its full text when the label is cut at 200 characters", () => {
    const line = `cd /w; files=(${"packages/x/src/a.ts ".repeat(12)}); for f in "\${files[@]}"; do vp fmt --stdin-filepath="$f" < "$f"; done`;
    const history = { "vp fmt files": [run(1, 0.2, 2_000)] };
    expect(
      estimate(history, { label: line.slice(0, 200), line }, 10, HEAVY_QUEUE_DEFAULTS),
    ).toEqual({ cpu: 1, memoryBytes: 0.2 * GIB, durationMs: 2_000 });
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
      name: "a job that just started counts its estimate, not a whole settle window",
      entries: [entry("r", "vp run build", 5_000), entry("a", "vp run typecheck")],
      change: { lastStartAt: NOW - 5_000 },
      admit: "a",
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
      reason: { a: "memory floor: 2.6 GB room, needs 4.0 GB" },
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
        head: "memory floor: 2.6 GB room, needs 4.0 GB",
        mid: "memory floor: 2.6 GB room, needs 4.0 GB",
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
        // Two minutes: a standard job, which the machine's limits hold; a quick one would pass.
        history: { "vp run lint": [run(0.5, 400 / 1024, 120_000)] },
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
        history: { "vp run lint": [run(0.5, 0.1, 120_000)] },
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
    admits?: ReadonlyArray<string>;
    hold?: string;
    reason?: Record<string, string>;
  }>)("$name", ({ entries, change, admit, admits, hold, reason }) => {
    const result = plan({ ...base, ...change, entries });
    expect(result.admits).toEqual(admits ?? (admit === null ? [] : [admit]));
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
  ])("switched off, holds no waiter despite $name", ({ change, entries }) => {
    const waiters = [entry("a", "xcrun simctl boot y"), entry("b", "vp run build")];
    const off = plan({ ...base, ...change, enabled: false, entries: [...entries, ...waiters] });
    expect(off).toEqual({
      admits: ["a", "b"],
      reasons: {},
      room: true,
      holding: false,
      hold: null,
    });
    const on = plan({ ...base, ...change, entries: [...entries, ...waiters] });
    expect(on.admits).toEqual([]);
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
      expect(result.admits).toEqual(["f"]);
      expect(result.reasons["n"]).toBeDefined();
      const held = plan({ ...base, ...change, entries: [...entries, entry("n", "vp run build")] });
      expect(held.admits).toEqual([]);
    },
  );

  it("admits every forced waiter at once, in queue order", () => {
    const entries = [
      ...full,
      entry("n", "vp run build"),
      forced("f2", "vp run build"),
      forced("f1", "vp run build"),
    ];
    expect(plan({ ...base, paused: true, entries }).admits).toEqual(["f2", "f1"]);
  });

  it("asks for a higher memory level to reopen after pressure, so admission does not flap", () => {
    const entries = [entry("r", "vp run build", 60_000), entry("a", "vp run build")];
    const history = { "vp run build": [run(2, 4, 60_000)] };
    // 11.9 - 4 GiB sits above the 20% floor (6.4) but below the 25% reopen level (8).
    const tight = { ...calm, availableMemoryBytes: 11.9 * GIB };
    expect(plan({ ...base, history, entries, sample: tight, holding: false }).admits).toEqual([
      "a",
    ]);
    expect(plan({ ...base, history, entries, sample: tight, holding: true }).admits).toEqual([]);
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
    expect(first.admits).toEqual(["small"]);
    // Each waiter plans again under the lock with what the last plan stored.
    expect(
      plan({ ...base, history, entries, sample: sixteen, holding: first.holding }).admits,
    ).toEqual(["small"]);
  });
});

describe("admission by real capacity", () => {
  /** The reading in the incident's screenshot: CPU 26%, 4.2 GB free of 16, pressure 1. */
  const q2 = {
    ...calm,
    busyCores: 2.6,
    availableMemoryBytes: 4.2 * GIB,
    totalMemoryBytes: 16 * GIB,
    pressureLevel: 1,
  };
  const sized = { ...base, sample: q2 };
  const history = {
    "vp run build": [run(2, 2.5, 300_000)],
    "vp run bundle": [run(1, 0.8, 60_000)],
    "vp run compile": [run(1, 0.6, 60_000)],
    "vp run e2e": [run(1, 1, 600_000)],
    "vp run docker": [run(0.5, 0.05, 600_000)],
  };
  const aged = 10 * 60_000;

  it.each([
    {
      row: 33,
      name: "the 5th waiter that fits starts; the four too big for the room wait",
      entries: [
        entry("r", "vp run e2e", 60_000),
        ...["w1", "w2", "w3", "w4"].map((id) => entry(id, "vp run build")),
        entry("w5", "vp run bundle"),
      ],
      admits: ["w5"],
      hold: "job-memory",
      reasons: { w1: "memory floor: 1.0 GB room, needs 2.5 GB" },
    },
    {
      row: 34,
      name: "two that fit alone: the first starts, the second counts it",
      entries: [
        entry("r", "vp run e2e", 60_000),
        entry("a", "vp run compile"),
        entry("b", "vp run compile"),
      ],
      admits: ["a"],
      reasons: { b: "waiting for room: a job just started" },
    },
    {
      row: 35,
      name: "an aged head that fits once the queue's jobs end keeps its room",
      entries: [
        entry("r1", "vp run e2e", 60_000),
        entry("r2", "vp run e2e", 60_000),
        entry("head", "vp run build", null, aged),
        entry("w", "vp run bundle"),
      ],
      admits: [],
      hold: "job-memory",
      reasons: { w: "waiting for room for the head job" },
    },
    {
      row: 48,
      name: "an aged head short on room from load outside the queue blocks no one",
      entries: [
        entry("r", "vp run docker", 60_000),
        entry("head", "vp run build", null, aged),
        entry("w", "vp run bundle"),
      ],
      admits: ["w"],
      hold: "job-memory",
      reasons: { head: "memory floor: 1.0 GB room, needs 2.5 GB" },
    },
    {
      row: 36,
      name: "an exclusive head within its patience lets a job that fits start",
      entries: [
        entry("r", "vp run e2e", 60_000),
        entry("boot", "xcrun simctl boot x"),
        entry("w", "vp run compile"),
      ],
      admits: ["w"],
      hold: "runs-alone",
      reasons: { boot: "the next job runs alone" },
    },
    {
      row: 37,
      name: "an aged exclusive head drains: nothing new starts until it runs",
      entries: [
        entry("r", "vp run e2e", 60_000),
        entry("boot", "xcrun simctl boot x", null, aged),
        entry("w", "vp run compile"),
      ],
      admits: [],
      hold: "runs-alone",
      reasons: { w: "waiting for the job that runs alone to start" },
    },
  ])("row $row: $name", ({ entries, admits, hold, reasons }) => {
    const result = plan({ ...sized, history, entries });
    expect(result.admits).toEqual(admits);
    if (hold !== undefined) expect(result.hold).toBe(hold);
    for (const [id, text] of Object.entries(reasons)) expect(result.reasons[id]).toBe(text);
  });

  it("row 50: a run's build daemons still alive are already in the reading, not in its cost", () => {
    const daemonRun = { ...run(1, 2.4, 60_000), treeMemoryBytes: 0.8 * GIB };
    const entries = [entry("r", "vp run docker", 60_000), entry("t", "vp run gradle")];
    const books = { ...history, "vp run gradle": [daemonRun] };
    const gone = plan({ ...sized, history: books, entries });
    expect(gone.admits).toEqual([]);
    expect(gone.reasons["t"]).toBe("memory floor: 1.0 GB room, needs 2.4 GB");
    const alive = { ...q2, buildDaemonsAlive: true };
    expect(plan({ ...sized, history: books, entries, sample: alive }).admits).toEqual(["t"]);
  });

  it("row 17: a job idle long enough is a service and frees its slot", () => {
    const idle = {
      ...entry("srv", "node server.js", 13 * 60_000),
      idleSince: NOW - 12 * 60_000,
    };
    const result = plan({
      ...sized,
      sample: { ...q2, availableMemoryBytes: 8 * GIB },
      history,
      maxRunning: 1,
      entries: [idle, entry("w", "vp run compile")],
    });
    expect(result.admits).toEqual(["w"]);
    const busy = { ...idle, idleSince: NOW - 60_000 };
    expect(
      plan({
        ...sized,
        sample: { ...q2, availableMemoryBytes: 8 * GIB },
        history,
        maxRunning: 1,
        entries: [busy, entry("w", "vp run compile")],
      }).admits,
    ).toEqual([]);
  });

  it("starts the aged head as soon as its room appears", () => {
    const entries = [
      entry("r1", "vp run e2e", 60_000),
      entry("head", "vp run build", null, aged),
      entry("w", "vp run bundle"),
    ];
    const roomy = { ...q2, availableMemoryBytes: 6 * GIB };
    expect(plan({ ...sized, history, entries, sample: roomy }).admits).toEqual(["head"]);
  });

  it("never admits past the room or the slots, whatever the order and class of waiters", () => {
    const labels = [
      ...Object.keys(history),
      "vp fmt a.ts",
      "vp lint a.ts b.ts",
      "git commit -m x a.ts",
      "vp run dev",
    ];
    const pick = () => labels[Math.floor(next() * labels.length)]!;
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const lanes = { ...sized, history };
    for (let round = 0; round < 500; round++) {
      const running = Array.from({ length: Math.floor(next() * 4) }, (_, i) =>
        entry(`r${i}`, pick(), 1_000 + next() * 60_000),
      );
      const waiters = Array.from({ length: 1 + Math.floor(next() * 7) }, (_, i) =>
        entry(`w${i}`, pick(), null, next() * 2 * aged),
      );
      const sample = { ...q2, availableMemoryBytes: (3.5 + next() * 4) * GIB };
      const input = { ...sized, history, sample, maxRunning: 3, entries: [...running, ...waiters] };
      const result = plan(input);
      const admitted = result.admits.map((id) => waiters.find((waiter) => waiter.id === id)!);
      const count = (jobs: ReadonlyArray<HeavyQueueEntry>, lane: string) =>
        jobs.filter((job) => laneOf(lanes, job) === lane).length;
      for (const [lane, cap] of [
        ["standard", 3],
        ["quick", QUICK_SLOTS],
        ["commit", 1],
      ] as const) {
        expect(count(running, lane) + count(admitted, lane)).toBeLessThanOrEqual(
          Math.max(
            cap,
            count(running, lane) +
              (count(running, "standard") + count(running, "quick") + count(running, "commit") === 0
                ? 1
                : 0),
          ),
        );
      }
      // Outside the exceptions (nothing running, the commit slot), nothing passes the room.
      if (running.every((job) => laneOf(lanes, job) === "service")) continue;
      const fresh = running.filter((job) => NOW - Date.parse(job.startedAt!) < 15_000);
      const cost = (job: HeavyQueueEntry) => estimate(history, job, q2.cpuCount, base);
      const room =
        sample.availableMemoryBytes -
        0.2 * sample.totalMemoryBytes -
        fresh.reduce((sum, job) => sum + cost(job).memoryBytes, 0);
      const counted = admitted.filter((job) => !["commit", "service"].includes(laneOf(lanes, job)));
      expect(counted.reduce((sum, job) => sum + cost(job).memoryBytes, 0)).toBeLessThanOrEqual(
        Math.max(0, room) + 1,
      );
      // CPU binds standard jobs; a quick job passes it by design.
      const cpuRoom =
        q2.cpuCount * 0.7 - q2.busyCores - fresh.reduce((sum, job) => sum + cost(job).cpu, 0);
      const standardCpu = admitted
        .filter((job) => laneOf(lanes, job) === "standard")
        .reduce((sum, job) => sum + cost(job).cpu, 0);
      expect(standardCpu).toBeLessThanOrEqual(Math.max(0, cpuRoom) + 1e-9);
    }
  });

  const fmt = (id: string, startedMsAgo: number | null = null) =>
    entry(id, `vp fmt ${id}.ts`, startedMsAgo);
  const roomy = { ...q2, availableMemoryBytes: 8 * GIB };

  it.each([
    {
      row: 19,
      name: "a device boot starts beside a running service",
      entries: [
        entry("dev", "vp run dev", 60_000),
        { ...entry("boot", "Open iPhone 17"), server: true },
      ],
      admits: ["boot"],
    },
    {
      row: 21,
      name: "critical pressure holds a quick job, even with only a service running",
      entries: [entry("dev", "vp run dev", 60_000), fmt("q")],
      sample: { ...q2, pressureLevel: 4 },
      admits: [],
      reasons: { q: "memory pressure critical" },
    },
    {
      row: 22,
      name: "the pause holds a quick job",
      entries: [entry("r", "vp run e2e", 60_000), fmt("q")],
      paused: true,
      admits: [],
      reasons: { q: "paused" },
    },
    {
      row: 23,
      name: "two quick jobs start and the third waits only for them",
      entries: [entry("r", "vp run e2e", 60_000), fmt("a"), fmt("b"), fmt("c")],
      sample: roomy,
      admits: ["a", "b"],
      reasons: { c: "2 quick jobs running" },
    },
    {
      row: "23b",
      name: "a standard head that fits starts before the quick jobs behind it",
      entries: [entry("r", "vp run e2e", 60_000), entry("head", "vp run compile"), fmt("a")],
      sample: roomy,
      admits: ["head", "a"],
    },
    {
      row: "5",
      name: "a quick job passes a full set of standard slots and a settling start",
      entries: [
        entry("r1", "vp run e2e", 60_000),
        entry("r2", "vp run e2e", 60_000),
        entry("r3", "vp run compile", 2_000),
        entry("w", "vp run build"),
        fmt("q"),
      ],
      sample: roomy,
      admits: ["q"],
      reasons: { w: "all 3 slots busy" },
    },
    {
      row: "5",
      name: "a quick job passes a job that runs alone, running or at the head",
      entries: [
        { ...entry("boot", "Open iPhone 17", 60_000), server: true },
        entry("next", "xcrun simctl boot y"),
        fmt("q"),
      ],
      sample: roomy,
      admits: ["q"],
    },
    {
      row: "6",
      name: "a quick job too big for the room waits with its own reason; the next one starts",
      entries: [
        entry("r", "vp run e2e", 60_000),
        entry("big", "vp test run big.test.ts"),
        fmt("q"),
      ],
      history: { "vp test run big.test.ts": [run(1, 2, 5_000)] },
      admits: ["q"],
      reasons: { big: "memory floor: 1.0 GB room, needs 2.0 GB" },
    },
    {
      row: 32,
      name: "a hooked commit fifth in line starts in its own slot whatever its memory",
      entries: [
        entry("r", "vp run e2e", 60_000),
        ...["w1", "w2", "w3", "w4"].map((id) => entry(id, "vp run build")),
        entry("commit", "git commit -m x a.ts"),
      ],
      history: { [signatureOf("git commit -m x a.ts")]: [run(2, 3.6, 120_000)] },
      admits: ["commit"],
    },
    {
      row: 8,
      name: "a second commit waits for the one running",
      entries: [entry("c1", "git commit -m x a.ts", 5_000), entry("c2", "git commit -m y b.ts")],
      admits: [],
      reasons: { c2: "a commit is running" },
    },
    {
      row: 35,
      name: "a quick job starts past the aged head's reservation within twice its patience",
      entries: [
        entry("r1", "vp run e2e", 60_000),
        entry("r2", "vp run e2e", 60_000),
        entry("head", "vp run build", null, 6 * 60_000),
        entry("w", "vp run bundle"),
        fmt("q"),
      ],
      admits: ["q"],
      reasons: { w: "waiting for room for the head job" },
    },
    {
      row: 49,
      name: "past twice the head's patience a quick job respects its reservation",
      entries: [
        entry("r1", "vp run e2e", 60_000),
        entry("r2", "vp run e2e", 60_000),
        entry("head", "vp run build", null, aged),
        fmt("q"),
      ],
      admits: [],
      reasons: { q: "waiting for room for the head job" },
    },
  ] as ReadonlyArray<{
    row: number | string;
    name: string;
    entries: ReadonlyArray<HeavyQueueEntry>;
    sample?: typeof q2;
    paused?: boolean;
    history?: Record<string, ReadonlyArray<Run>>;
    admits: ReadonlyArray<string>;
    reasons?: Record<string, string>;
  }>)("row $row: $name", ({ entries, sample, paused, admits, reasons, ...rest }) => {
    const result = plan({
      ...sized,
      history: { ...history, ...rest.history },
      entries,
      sample: sample ?? q2,
      paused: paused ?? false,
    });
    expect(result.admits).toEqual(admits);
    for (const [id, text] of Object.entries(reasons ?? {})) expect(result.reasons[id]).toBe(text);
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
    expect(plan(floor).admits).toEqual(["a"]);
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
