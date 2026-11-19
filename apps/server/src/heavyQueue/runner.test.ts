// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  HEAVY_QUEUE_DEFAULTS,
  heavyHoldText,
  type HeavyQueueEntry,
  type RunnerLinuxFullPolicy,
  type RunnerProjectConfig,
} from "@t3tools/contracts";

import { signatureOf } from "./admission.ts";
import {
  DEFAULT_MACHINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  eligibilityOf,
  foldMarker,
  installFailure,
  linkMachine,
  LINUX_EVICT_SHARE,
  LINUX_FULL_SHORTER,
  LINUX_FULL_WAITING,
  linuxStops,
  macReasonText,
  matchesAny,
  mayPublish,
  nextHealth,
  needsBrowser,
  NO_PROGRESS,
  parseHeartbeat,
  planRoutes,
  platformFailures,
  remoteOutcome,
  remotePgidScript,
  remoteStopScript,
  removeCopyScript,
  runnerCopyId,
  runnerConfigFor,
  sshArgs,
  UNKNOWN_HEALTH,
  MARKER,
  type HealthCheck,
  type LinuxHealth,
  type QueuedEntry,
  type RoutePlanInput,
  type RunnerBlock,
} from "./runner.ts";

const GIB = 1024 ** 3;
const NOW = Date.parse("2026-01-01T01:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const job = (id: string, label: string, extra: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label,
  cwd: `/work/${id}`,
  createdAt: ago(60_000),
  startedAt: null,
  ...extra,
});
const runningOn = (id: string, runner: "mac" | "linux", cwd = `/work/${id}`) =>
  job(id, "vp test run", {
    startedAt: ago(600_000),
    cwd,
    ...(runner === "linux" ? { runner: "linux" as const } : {}),
  });

const ONLINE: LinuxHealth = { ...UNKNOWN_HEALTH, online: true, okAt: NOW - 1000 };
const OFFLINE: LinuxHealth = { ...UNKNOWN_HEALTH, online: false, failures: 2 };
/** A heartbeat with numbers: 8 of 12 GiB free, 8% CPU, load 0.5 on 6 cores. */
const READ: LinuxHealth = {
  ...ONLINE,
  cpuPercent: 8,
  load1: 0.5,
  cpuCount: 6,
  availableMemoryBytes: 8 * GIB,
  totalMemoryBytes: 12 * GIB,
};
const OVERLOADED: LinuxHealth = {
  ...READ,
  availableMemoryBytes: 1.8 * GIB,
  overLimit: true,
  overLimitSince: NOW - 60_000,
};
const CALM = {
  at: NOW - 1000,
  busyCores: 1,
  cpuCount: 10,
  availableMemoryBytes: 20 * GIB,
  totalMemoryBytes: 32 * GIB,
  headroomSince: NOW - 60_000,
};

const input = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  config: Partial<RunnerProjectConfig> = {},
  over: Partial<RoutePlanInput> = {},
): RoutePlanInput => ({
  entries,
  maxRunning: 3,
  enabled: true,
  paused: false,
  history: {},
  sample: {
    at: NOW - 1000,
    busyCores: 1,
    cpuCount: 10,
    availableMemoryBytes: 20 * GIB,
    totalMemoryBytes: 32 * GIB,
    headroomSince: NOW - 60_000,
  },
  lastStartAt: null,
  holding: false,
  ...HEAVY_QUEUE_DEFAULTS,
  now: NOW,
  contextOf: (cwd) => ({
    config: { ...DEFAULT_PROJECT_CONFIG, runnerEnabled: true, ...config },
    worktree: cwd,
    home: "/home/me",
    rootOf: () => "/work",
  }),
  machine: DEFAULT_MACHINE_CONFIG,
  health: ONLINE,
  ...over,
});

type Outcome = "mac-start" | "mac-wait" | "linux-start" | "linux-wait" | "ask";
const outcomeOf = (plan: ReturnType<typeof planRoutes>, id: string): Outcome => {
  const admit = plan.admits[id];
  if (admit !== undefined) return admit.runner === "linux" ? "linux-start" : "mac-start";
  if (plan.asks[id] !== undefined) return "ask";
  return plan.routes[id] === "linux" ? "linux-wait" : "mac-wait";
};

describe("routing matrix", () => {
  // "off-paused": the queue switched off with a pause left on from before; it is plain off.
  const queues = ["on", "off", "paused", "off-paused"] as const;
  const runners = [true, false] as const;
  const wheres = ["mac", "linux", "automatic", "macFirst"] as const;
  const linuxStates = [
    "online",
    "full",
    "same-worktree",
    "overloaded",
    "stale",
    "offline",
    "unknown",
  ] as const;
  // "spike": the latest reading is over the limits, but not for the whole window. "holding": a
  // spike while admission already holds the Mac back (`holding`), which moves nothing by itself.
  const macStates = ["room", "full", "over", "spike", "holding"] as const;
  const kinds = {
    eligible: "vp test run",
    exclusive: "xcrun simctl boot iPhone",
    "mac-only": "vp test run --project ios -- xcodebuild",
  } as const;
  const linuxRunningIn = { full: 2, "same-worktree": 1, stale: 1 } as Record<string, number>;

  /** The spec's routing rules, written out case by case. */
  const expected = (
    queue: (typeof queues)[number],
    runner: boolean,
    where: (typeof wheres)[number],
    linux: (typeof linuxStates)[number],
    mac: (typeof macStates)[number],
    kind: keyof typeof kinds,
  ): Outcome => {
    const off = queue === "off" || queue === "off-paused";
    // Mac admission: queue off starts at once; paused holds; full slots, a reading past the
    // limits (even a spike) or a job that must run alone hold.
    const onMac: Outcome = off
      ? "mac-start"
      : queue === "paused" || mac !== "room" || kind === "exclusive"
        ? "mac-wait"
        : "mac-start";
    if (!runner || kind !== "eligible" || where === "mac") return onMac;
    const linuxRoom = linux === "online";
    if (where === "linux") {
      if (queue === "paused") return "linux-wait";
      if (linux === "offline") return "ask";
      return linuxRoom ? "linux-start" : "linux-wait";
    }
    if (linux === "offline" || linux === "unknown") return onMac;
    if (where === "automatic" && queue === "paused") return onMac;
    const linuxStart: Outcome = linuxRoom ? "linux-start" : "linux-wait";
    // Both over their limits: it holds, with the queue on or off.
    if (mac === "over" && linux === "overloaded") return "linux-wait";
    // Mac first, sending to Linux from 2 jobs: 1 runs here except when the Mac is full, and past
    // its count still runs here while Linux is over its limits (RUN-13).
    if (where === "macFirst") {
      if (mac !== "over" && (mac !== "full" || linux === "overloaded")) return onMac;
      return queue === "paused" ? "linux-wait" : linuxStart;
    }
    // Hybrid: the smaller backlog per slot (3 here, 2 there), the Mac on a tie.
    const macLine = (mac === "full" ? 3 : 1) / 3;
    const linuxLine = (linuxRunningIn[linux] ?? 0) / 2;
    let here = macLine <= linuxLine;
    if (here && mac === "over") here = false;
    else if (!here && linux === "overloaded") here = true;
    // A machine that can start it now takes it from one that can't.
    const macRoom = off ? mac !== "over" : mac === "room" || mac === "spike" || mac === "holding";
    if (here && linuxRoom && !macRoom) here = false;
    else if (!here && !linuxRoom && macRoom) here = true;
    return here ? onMac : linuxStart;
  };

  const cases = queues.flatMap((queue) =>
    runners.flatMap((runner) =>
      wheres.flatMap((where) =>
        linuxStates.flatMap((linux) =>
          macStates.flatMap((mac) =>
            (Object.keys(kinds) as Array<keyof typeof kinds>).map(
              (kind) => [queue, runner, where, linux, mac, kind] as const,
            ),
          ),
        ),
      ),
    ),
  );

  it.each(cases)(
    "queue %s, runner %s, %s, Linux %s, Mac %s, %s job",
    (queue, runner, where, linux, mac, kind) => {
      const entries = [
        ...Array.from({ length: mac === "full" ? 3 : 1 }, (_, i) => runningOn(`mac${i}`, "mac")),
        ...(linux === "full"
          ? [runningOn("l1", "linux"), runningOn("l2", "linux")]
          : linux === "same-worktree"
            ? [runningOn("l1", "linux", "/work/w")]
            : linux === "stale"
              ? [{ ...runningOn("l1", "linux"), startedAt: ago(500) }]
              : []),
        job("w", kinds[kind]),
      ];
      const over = mac === "over" || mac === "spike" || mac === "holding";
      const plan = planRoutes(
        input(
          entries,
          { runnerEnabled: runner, runnerWhere: where, runnerMacFirstAfter: 2 },
          {
            enabled: queue === "on" || queue === "paused",
            paused: queue === "paused" || queue === "off-paused",
            holding: mac === "holding",
            sample: {
              ...CALM,
              ...(over ? { busyCores: 9, headroomSince: null } : {}),
              overLimit: mac === "over",
            },
            health:
              linux === "offline"
                ? OFFLINE
                : linux === "unknown"
                  ? UNKNOWN_HEALTH
                  : linux === "overloaded"
                    ? OVERLOADED
                    : READ,
          },
        ),
      );
      expect(outcomeOf(plan, "w")).toBe(expected(queue, runner, where, linux, mac, kind));
    },
  );

  it("a Mac over its ceiling holds back none of the incident's jobs while Linux is up", () => {
    const shapes = [
      "vp fmt a.ts b.tsx && vp lint --no-ignore a.ts b.tsx",
      'f=(a.ts); vp fmt "${f[@]}" && vp test run src/a.test.ts',
      "pnpm exec vp fmt src/x.ts && pnpm exec effect-tsgo tsrs --noEmit",
      "vp run fmt src/a.ts; vp run typecheck",
      "vp fmt --check && vp test run",
      "./node_modules/.bin/vp lint --no-ignore a.tsx",
      "sh -c './gate.sh'",
    ];
    const scripts = {
      "./node_modules/.bin/vp": "case x in\n*) ;;\nesac\n",
      "./gate.sh": "vp test run\n",
    };
    const entries = [
      runningOn("release", "mac"),
      ...shapes.map((label, at) => ({ ...job(`w${at}`, label), scripts }) as QueuedEntry),
    ];
    const strained = (health: LinuxHealth) =>
      planRoutes(
        input(
          entries,
          { runnerWhere: "linux", runnerUnavailable: "mac" },
          {
            holding: true,
            sample: { ...CALM, busyCores: 9.8, headroomSince: null, overLimit: true },
            health,
            machine: { ...DEFAULT_MACHINE_CONFIG, runnerLinuxSlots: 5 },
          },
        ),
      );
    const up = strained(READ);
    expect(shapes.map((_, at) => up.routes[`w${at}`])).toEqual(shapes.map(() => "linux"));
    expect(up.admits.w0).toEqual({ runner: "linux", ungated: false });
    // Down, all stay here; a busy CPU holds standard work, while quick checks have their own slots.
    const down = strained(OFFLINE);
    expect(shapes.map((_, at) => outcomeOf(down, `w${at}`))).toEqual([
      "mac-start",
      "mac-start",
      ...shapes.slice(2).map(() => "mac-wait"),
    ]);
  });

  it("Hybrid with three Mac slots and five agents splits them by backlog per slot", () => {
    const entries = ["a", "b", "c", "d", "e"].map((id) => job(id, "vp test run"));
    const plan = planRoutes(input(entries, { runnerWhere: "automatic" }, { health: READ }));
    // 0/3 vs 0/2 ties to the Mac; then 1/3 vs 0/2, 1/3 vs 1/2, 2/3 vs 1/2, 3/3 vs 2/2.
    expect(plan.routes).toEqual({ a: "mac", b: "linux", c: "mac", d: "linux", e: "mac" });
    // The second Linux job waits for a reading that shows the first one's load.
    expect(plan.admits).toEqual({
      a: { runner: "mac", ungated: false },
      b: { runner: "linux", ungated: false },
    });
    expect(plan.reasons.d).toBe(
      "waiting for Linux: a reading a minute after the last job started there",
    );
  });

  it("Hybrid sends the waiters past a full Mac to the shorter line, the Mac on a tie", () => {
    const entries = [
      ...["m1", "m2", "m3"].map((id) => runningOn(id, "mac")),
      runningOn("l1", "linux"),
      ...["a", "b", "c"].map((id) => job(id, "vp test run")),
    ];
    // Mac 3 of 3 against Linux 1 of 2 sends a; then 3/3 against 2/2 is a tie, so b stays here.
    const plan = planRoutes(
      input(entries, { runnerWhere: "automatic" }, { health: { ...READ, okAt: NOW - 1000 } }),
    );
    expect(plan.routes).toMatchObject({ a: "linux", b: "mac", c: "linux" });
    expect(plan.admits.a).toEqual({ runner: "linux", ungated: false });
    // Recomputed from the same state, the answer is the same: rows never flap.
    expect(
      planRoutes(input(entries, { runnerWhere: "automatic" }, { health: READ })).routes,
    ).toEqual(plan.routes);
  });

  it("Hybrid treats a job that runs alone on the Mac as no room, and never asks for Linux", () => {
    const entries = [runningOn("sim", "mac"), job("a", "vp test run")];
    entries[0] = { ...entries[0]!, label: "xcrun simctl boot iPhone" };
    const plan = planRoutes(input(entries, { runnerWhere: "automatic" }, { health: READ }));
    expect(plan.admits.a).toEqual({ runner: "linux", ungated: false });
    const offline = planRoutes(input(entries, { runnerWhere: "automatic" }, { health: OFFLINE }));
    expect(offline.asks).toEqual({});
    expect(offline.routes.a).toBe("mac");
  });

  it("with the queue off, Hybrid sends work to Linux while the Mac stays over its limits, and holds past both", () => {
    const entries = [job("a", "vp test run")];
    const off = (overLimit: boolean, health: LinuxHealth) =>
      planRoutes(
        input(
          entries,
          { runnerWhere: "automatic" },
          {
            enabled: false,
            health,
            sample: { ...CALM, busyCores: 9, headroomSince: null, overLimit },
          },
        ),
      ).admits.a;
    expect(off(true, READ)).toEqual({ runner: "linux", ungated: true });
    expect(off(false, READ)).toEqual({ runner: "mac", ungated: true });
    expect(off(true, OVERLOADED)).toBeUndefined();
    // A stale Mac reading says nothing about its limits now.
    expect(
      planRoutes(
        input(
          entries,
          { runnerWhere: "automatic" },
          {
            enabled: false,
            sample: { ...CALM, at: NOW - 60_000, overLimit: true },
          },
        ),
      ).admits.a,
    ).toEqual({ runner: "mac", ungated: true });
  });

  it("an overloaded Linux keeps its jobs waiting with the reason, never asking", () => {
    const plan = planRoutes(
      input([job("a", "vp test run")], { runnerWhere: "linux" }, { health: OVERLOADED }),
    );
    expect(plan.asks).toEqual({});
    expect(plan.reasons.a).toBe("waiting for Linux: 1.8 GB free, keeping 20%");
    const cpu = planRoutes(
      input(
        [job("a", "vp test run")],
        { runnerWhere: "linux" },
        {
          health: { ...READ, cpuPercent: 90, overLimit: true },
        },
      ),
    );
    expect(cpu.reasons.a).toBe("waiting for Linux: CPU 90%, limit 70%");
    const easing = planRoutes(
      input(
        [job("a", "vp test run")],
        { runnerWhere: "linux" },
        {
          health: { ...READ, overLimit: true },
        },
      ),
    );
    expect(easing.reasons.a).toBe("waiting for Linux: easing back under its limits");
  });

  // 17/11 16:42: five starts one heartbeat apart, each before the last one's load showed.
  it("the next Linux start waits for a reading a minute after the last one started", () => {
    const starts = (startedAgo: number, health: LinuxHealth = READ) =>
      Object.keys(
        planRoutes(
          input(
            [
              { ...runningOn("l1", "linux"), startedAt: ago(startedAgo) },
              ...["a", "b", "c", "d", "e"].map((id) => job(id, "vp test run")),
            ],
            { runnerWhere: "linux" },
            { health, machine: { ...DEFAULT_MACHINE_CONFIG, runnerLinuxSlots: 6 } },
          ),
        ).admits,
      );
    expect(starts(20_000)).toEqual([]);
    // With no numbers in the heartbeat as well.
    expect(starts(20_000, ONLINE)).toEqual([]);
    expect(starts(70_000)).toEqual(["a"]);
    // The reading (a second old) is exactly a minute after the start, or just short of it.
    expect(starts(61_000)).toEqual(["a"]);
    expect(starts(60_999)).toEqual([]);
  });

  it.each([
    ["a reading 5 minutes old", { ...READ, okAt: NOW - 300_000 }, "a fresh reading of Linux"],
    ["no reading yet", { ...READ, okAt: null }, "a fresh reading of Linux"],
    // Under the sustained limits, but past the instant ones: no new start.
    [
      "10% memory free",
      { ...READ, availableMemoryBytes: 1.2 * GIB, overLimit: false },
      "1.2 GB free, keeping 20%",
    ],
    ["CPU at 95%", { ...READ, cpuPercent: 95, overLimit: false }, "CPU 95%, limit 70%"],
  ] as const)("with %s nothing starts on Linux", (_, health, why) => {
    const plan = planRoutes(input([job("a", "vp test run")], { runnerWhere: "linux" }, { health }));
    expect(plan.admits).toEqual({});
    expect(plan.reasons.a).toBe(`waiting for Linux: ${why}`);
  });

  // Stopped twice for memory beside others: only alone, so stop and start never loop.
  it.each([
    ["twice, beside another Linux job", [runningOn("l1", "linux")], 2, 2, "linux-wait"],
    ["twice, Linux idle", [], 2, 2, "linux-start"],
    ["once, set to 1, beside another Linux job", [runningOn("l1", "linux")], 1, 1, "linux-wait"],
    ["once, by default, beside another Linux job", [runningOn("l1", "linux")], 1, 2, "linux-start"],
  ] as const)("a job evicted %s", (_, beside, evictions, setting, outcome) => {
    const plan = planRoutes(
      input(
        [...beside, job("a", "vp test run", { evictions } as never)],
        { runnerWhere: "linux" },
        {
          health: READ,
          machine: { ...DEFAULT_MACHINE_CONFIG, runnerLinuxEvictionsBeforeAlone: setting },
        },
      ),
    );
    expect(outcomeOf(plan, "a")).toBe(outcome);
    if (outcome === "linux-wait") {
      expect(plan.reasons.a).toBe(
        "waiting for Linux: Linux ran short of memory beside other jobs: waiting to run there alone",
      );
    }
  });

  it("Linux admits no one past a job waiting to run there alone, then takes it once empty", () => {
    const queue = [
      job("a", "vp test run", { evictions: 2 } as never),
      job("b", "vp test run"),
      job("c", "vp test run"),
    ];
    const plan = (beside: ReadonlyArray<HeavyQueueEntry>, where: "linux" | "automatic") =>
      planRoutes(input([...beside, ...queue], { runnerWhere: where }, { health: READ }));
    const draining = plan([runningOn("l1", "linux")], "linux");
    expect(["a", "b", "c"].map((id) => outcomeOf(draining, id))).toEqual([
      "linux-wait",
      "linux-wait",
      "linux-wait",
    ]);
    expect(draining.reasons.b).toBe(
      "waiting for Linux: Linux is kept free for a job that runs there alone",
    );
    expect(Object.keys(plan([], "linux").admits)).toEqual(["a"]);
    // Hybrid needn't wait for Linux to drain: this Mac has room for it.
    const hybrid = plan([runningOn("l1", "linux")], "automatic");
    expect(outcomeOf(hybrid, "a")).toBe("mac-start");
  });

  it("two waiters of one worktree never take Linux together", () => {
    const entries = [
      job("a", "vp test run", { cwd: "/w" }),
      job("b", "vp test run", { cwd: "/w" }),
    ];
    const plan = planRoutes(input(entries, { runnerWhere: "linux" }));
    expect(plan.admits).toEqual({ a: { runner: "linux", ungated: false } });
    expect(plan.reasons.b).toBe("waiting for Linux: this worktree is already running on Linux");
  });

  it("the job's own --runner wins over the project and takes unlisted work", () => {
    const plan = planRoutes(input([job("a", "just deploy", { where: "linux" })]));
    expect(plan.admits.a).toEqual({ runner: "linux", ungated: false });
  });

  it("the user's route wins, but never sends Mac-only work to Linux", () => {
    expect(
      planRoutes(input([job("a", "vp test run", { route: "mac" })], { runnerWhere: "linux" }))
        .admits.a,
    ).toEqual({ runner: "mac", ungated: false });
    expect(
      planRoutes(input([job("a", "xcodebuild test", { route: "linux" })])).admits.a?.runner,
    ).toBe("mac");
  });

  // 13:34: a job's sync timed out while this Mac swapped; ssh answered seconds later.
  it("a run that lost the link waits for Linux, and goes back once a heartbeat gets through", () => {
    const failed = job("a", "vp test run", { linuxFailedAt: NOW - 500, linkFailures: 1 } as never);
    const at = (okAt: number) =>
      outcomeOf(
        planRoutes(
          input(
            [failed],
            { runnerWhere: "linux", runnerUnavailable: "mac" },
            { health: { ...ONLINE, okAt } },
          ),
        ),
        "a",
      );
    expect(at(NOW - 1000)).toBe("linux-wait");
    expect(at(NOW - 100)).toBe("linux-start");
  });
});

describe("Mac first, Hybrid and Everything", () => {
  const QUEUE = [true, false] as const;
  const MAC_OVER = { sample: { ...CALM, busyCores: 9, headroomSince: null, overLimit: true } };
  const planned = (
    entries: ReadonlyArray<HeavyQueueEntry>,
    config: Partial<RunnerProjectConfig>,
    over: Partial<RoutePlanInput> = {},
  ) => planRoutes(input(entries, config, { health: READ, runnerOn: true, ...over }));
  const linuxFull = [runningOn("l1", "linux"), runningOn("l2", "linux")];

  it.each(QUEUE)(
    "Mac first fills this Mac up to its count, then Linux (queue on: %s)",
    (enabled) => {
      const entries = [
        runningOn("m0", "mac"),
        ...["a", "b", "c"].map((id) => job(id, "vp test run")),
      ];
      const plan = planned(
        entries,
        { runnerWhere: "macFirst", runnerMacFirstAfter: 2 },
        { enabled },
      );
      expect(plan.routes).toEqual({ a: "mac", b: "linux", c: "linux" });
      expect(plan.reasons.a).toMatch(/^Mac first: this Mac has room/);
      expect(plan.admits.b).toEqual({ runner: "linux", ungated: !enabled });
      // c waits for a Linux reading that shows b's load, and says why it is not here.
      expect(plan.reasons.c).toBe("Mac first: this Mac has 2 jobs");
    },
  );

  it.each(
    QUEUE.flatMap((enabled) => [
      [enabled, 1, "Mac first: this Mac has 1 job"],
      [enabled, 3, "Mac first: this Mac has 3 jobs"],
    ]),
  )(
    "Mac first counts this Mac's jobs in the waiting reason (queue on: %s, %i)",
    (enabled, count, reason) => {
      const entries = [
        ...Array.from({ length: count as number }, (_, at) => runningOn(`m${at}`, "mac")),
        job("a", "vp test run"),
        job("b", "vp test run"),
      ];
      const plan = planned(
        entries,
        { runnerWhere: "macFirst", runnerMacFirstAfter: count as number },
        { enabled: enabled as boolean },
      );
      expect(plan.routes).toEqual({ a: "linux", b: "linux" });
      expect(plan.reasons.b).toBe(reason);
    },
  );

  interface ModeRow {
    readonly enabled: boolean;
    readonly name: string;
    readonly config: Partial<RunnerProjectConfig>;
    readonly entries?: ReadonlyArray<HeavyQueueEntry>;
    readonly over?: Partial<RoutePlanInput>;
    readonly route: "mac" | "linux";
    readonly reason?: RegExp;
    readonly admit?: "linux";
  }
  it.each(
    QUEUE.flatMap((enabled): ReadonlyArray<ModeRow> => [
      {
        enabled,
        name: "Mac first, Linux offline",
        config: { runnerWhere: "macFirst" as const },
        over: { health: OFFLINE },
        route: "mac",
        reason: /^Mac first: Linux is unavailable/,
      },
      {
        enabled,
        name: "Mac first, this Mac over its limits",
        config: { runnerWhere: "macFirst" as const },
        over: MAC_OVER,
        route: "linux",
        admit: "linux",
      },
      {
        enabled,
        name: "Mac first, past its count with Linux over its limits",
        config: { runnerWhere: "macFirst" as const, runnerMacFirstAfter: 1 },
        entries: [runningOn("m0", "mac")],
        over: { health: OVERLOADED },
        route: "mac",
        reason: /^Mac first: this Mac has room/,
      },
      {
        enabled,
        name: "Hybrid, Linux full",
        config: { runnerWhere: "automatic" as const },
        entries: linuxFull,
        route: "mac",
        reason: /^Hybrid: shorter queue here/,
      },
      {
        enabled,
        name: "Hybrid, Linux offline",
        config: { runnerWhere: "automatic" as const },
        over: { health: OFFLINE },
        route: "mac",
        reason: /^Hybrid: Linux is unavailable/,
      },
      {
        enabled,
        name: "Hybrid, this Mac over its limits and Linux full",
        config: { runnerWhere: "automatic" as const },
        entries: linuxFull,
        over: MAC_OVER,
        route: "linux",
        reason: /^Hybrid: this Mac is over its limits$/,
      },
      ...(["automatic", "macFirst"] as const).map((runnerWhere): ModeRow => ({
        enabled,
        name: `${runnerWhere}, both machines over their limits`,
        config: { runnerWhere },
        over: { ...MAC_OVER, health: OVERLOADED },
        route: "linux",
        reason: /^Both machines are at their limits$/,
      })),
    ]),
  )("$name (queue on: $enabled)", (row) => {
    const plan = planned([...(row.entries ?? []), job("a", "vp test run")], row.config, {
      enabled: row.enabled,
      ...row.over,
    });
    expect(plan.routes.a).toBe(row.route);
    if (row.reason !== undefined) expect(plan.reasons.a).toMatch(row.reason);
    // An idle Mac starts what it gets; Linux starts only a job it has room for.
    expect(plan.admits.a?.runner).toBe(row.route === "mac" ? "mac" : row.admit);
  });

  // RUN-12: Linux can't start it (its worktree runs there), the Mac has a free slot and no waiter.
  it.each(QUEUE)("Hybrid lets the Mac take a job Linux can't start (queue on: %s)", (enabled) => {
    const entries = [
      runningOn("m0", "mac"),
      runningOn("m1", "mac"),
      runningOn("l1", "linux", "/work/a"),
      job("a", "vp test run"),
    ];
    // 2 of 3 here against 1 of 2 there sends it to Linux, which can't start it.
    const plan = planned(entries, { runnerWhere: "automatic" }, { enabled });
    expect(plan.admits.a).toEqual({ runner: "mac", ungated: !enabled });
  });

  // ROUTE-051: each machine has its own line. A Mac-only waiter on a full Mac never holds back
  // a job Linux has room for.
  it.each(
    (["linux", "macFirst", "automatic"] as const).flatMap((where) =>
      [1, 3].flatMap((slots) =>
        (["xcodebuild test", "xcrun simctl boot iPhone"] as const).map(
          (head) => [where, slots, head] as const,
        ),
      ),
    ),
  )(
    "%s, this Mac's %i slots full and %j waiting there: Linux takes the next job",
    (where, slots, head) => {
      const entries = [
        ...Array.from({ length: slots }, (_, at) => runningOn(`m${at}`, "mac")),
        job("head", head),
        job("a", "vp test run"),
      ];
      const plan = planned(entries, { runnerWhere: where }, { maxRunning: slots });
      expect(plan.routes.head).toBe("mac");
      expect(plan.admits).toEqual({ a: { runner: "linux", ungated: false } });
    },
  );

  // RUN-14: a hand route holds in every mode, with the queue on or off.
  it.each(
    QUEUE.flatMap((enabled) =>
      (["mac", "macFirst", "automatic", "linux"] as const).map(
        (where) => [where, enabled] as const,
      ),
    ),
  )("%s keeps a job's hand route (queue on: %s)", (where, enabled) => {
    const entries = [
      job("a", "vp test run", { route: "linux" }),
      job("b", "vp test run", { route: "mac" }),
    ];
    const plan = planned(entries, { runnerWhere: where }, { enabled });
    expect(plan.routes).toEqual({ a: "linux", b: "mac" });
    expect(plan.admits.a).toEqual({ runner: "linux", ungated: !enabled });
  });

  // RUN-01: Linux takes builds too, never what has to stay on this Mac.
  it.each(
    QUEUE.flatMap((enabled) =>
      (
        [
          ["vp run build", "linux"],
          ["vp test run", "linux"],
          ["pnpm install", "mac"],
          ["xcodebuild test", "mac"],
          ["vp run dev", "mac"],
          ["vp run mobile:install ios", "mac"],
        ] as const
      ).map(([line, route]) => [line, enabled, route] as const),
    ),
  )("Linux, %s (queue on: %s) runs on %s", (line, enabled, route) => {
    const plan = planned([job("a", line)], { runnerWhere: "linux" }, { enabled });
    expect(plan.routes.a).toBe(route);
  });

  /** 10 jobs, two of them Mac-only, with their minutes; each in its own worktree. */
  const MIXED = [
    ["vp test run", 6],
    ["vp run lint", 2],
    ["vp test run --project ios -- xcodebuild", 5],
    ["vp run typecheck", 4],
    ["vp test run", 8],
    ["vp run lint", 3],
    ["vp test run", 5],
    ["vp test run --project ios -- xcodebuild", 4],
    ["vp run typecheck", 3],
    ["vp test run", 6],
  ] as const;

  /** Minutes until the last job ends, replanning each minute, with a reading each minute. */
  const makespan = (where: "mac" | "linux" | "automatic") => {
    const MINUTE = 60_000;
    const minutes = new Map(MIXED.map(([, length], at) => [`j${at}`, length]));
    let entries = MIXED.map(([line], at) => job(`j${at}`, line));
    const ends = new Map<string, number>();
    let t = 0;
    while (entries.length > 0) {
      const now = NOW + t * MINUTE;
      for (let started = true; started;) {
        const { admits } = planRoutes(
          input(
            entries,
            { runnerWhere: where },
            { now, health: { ...ONLINE, okAt: now }, sample: { ...CALM, at: now - 1000 } },
          ),
        );
        started = Object.keys(admits).length > 0;
        entries = entries.map((entry) => {
          const admit = admits[entry.id];
          if (admit === undefined) return entry;
          ends.set(entry.id, t + minutes.get(entry.id)!);
          const runner = admit.runner === "linux" ? { runner: "linux" as const } : {};
          return { ...entry, startedAt: new Date(now).toISOString(), ...runner };
        });
      }
      const running = entries.filter((entry) => entry.startedAt !== null);
      expect(running.length).toBeGreaterThan(0);
      t += 1;
      entries = entries.filter((entry) => entry.startedAt === null || ends.get(entry.id)! > t);
    }
    return t;
  };

  it("finishes a mixed queue of 10 sooner in Hybrid than on either machine alone", () => {
    const spans = {
      mac: makespan("mac"),
      linux: makespan("linux"),
      hybrid: makespan("automatic"),
    };
    expect(spans.hybrid).toBeLessThan(spans.mac);
    expect(spans.hybrid).toBeLessThan(spans.linux);
    expect(spans).toEqual({ mac: 19, linux: 21, hybrid: 13 });
  });
});

describe("When Linux is full", () => {
  const MAC_OVER = { ...CALM, busyCores: 9, headroomSince: null, overLimit: true };
  const STALE: LinuxHealth = { ...READ, okAt: NOW - 3_600_000 };
  const linuxJobs = (count: number) =>
    Array.from({ length: count }, (_, at) => runningOn(`l${at}`, "linux"));
  const macJobs = (count: number) =>
    Array.from({ length: count }, (_, at) => runningOn(`m${at}`, "mac"));
  const a = (extra: Partial<HeavyQueueEntry> = {}) => job("a", "vp test run", extra);
  /** Why Linux holds `a` back: each row's entries, health and Mac sample. */
  const HOLDS = {
    slots: { entries: [...linuxJobs(2), a()], health: READ },
    limits: { entries: [a()], health: OVERLOADED },
    worktree: { entries: [runningOn("l0", "linux", "/work/a"), a()], health: READ },
    reading: { entries: [a()], health: STALE },
    alone: { entries: [a(), job("z", "vp test run", { evictions: 2 } as never)], health: READ },
    aloneMemory: {
      entries: [...linuxJobs(1), a({ evictions: 2 } as never)],
      health: READ,
    },
  } as const;
  const MAC_STATES = {
    room: {},
    noRoom: { entries: macJobs(1), over: { maxRunning: 1 } },
    over: { over: { sample: MAC_OVER } },
  } as const;
  type Expect = "mac" | "shorter" | "wait" | "busier";
  const REASON: Record<Expect, RegExp> = {
    mac: /^Linux is full: running on this Mac$/,
    shorter: /^Linux is full: shorter queue on this Mac$/,
    busier: /^Linux is full: waiting \(this Mac is busier\)$/,
    wait: /^waiting for Linux: /,
  };
  type Hold = keyof typeof HOLDS;
  type MacState = keyof typeof MAC_STATES;
  const expectOf = (hold: Hold, policy: RunnerLinuxFullPolicy, mac: MacState): Expect => {
    if ((hold !== "slots" && hold !== "limits") || policy === "wait") return "wait";
    if (mac !== "room") return policy === "balance" ? "busier" : "wait";
    return policy === "mac" ? "mac" : "shorter";
  };
  const rows = (Object.keys(HOLDS) as Hold[]).flatMap((hold) =>
    (Object.keys(MAC_STATES) as MacState[]).flatMap((mac) =>
      (["wait", "mac", "balance"] as const).map(
        (policy) => [hold, policy, mac, expectOf(hold, policy, mac)] as const,
      ),
    ),
  );

  it.each(rows)("held by %s, policy %s, Mac %s: %s", (hold, policy, macState, expected) => {
    const { entries, health } = HOLDS[hold];
    const state: { entries?: ReadonlyArray<HeavyQueueEntry>; over?: Partial<RoutePlanInput> } =
      MAC_STATES[macState];
    const plan = planRoutes(
      input(
        [...(state.entries ?? []), ...entries],
        { runnerWhere: "linux", runnerLinuxFull: policy },
        { health, runnerOn: true, ...state.over },
      ),
    );
    expect(plan.routes.a).toBe(expected === "mac" || expected === "shorter" ? "mac" : "linux");
    expect(plan.admits.a?.runner).not.toBe("linux");
    expect(plan.reasons.a).toMatch(REASON[expected]);
  });

  // Backlog per slot, the job's own place included; a machine that can't start it now counts one.
  it.each([
    // [name, maxRunning, Mac jobs, policy, route]
    ["Mac has room", 3, 0, "balance", "mac"],
    ["no room, but 1/4 waits against Linux's 1/2", 4, 4, "balance", "mac"],
    ["the same queue under mac: no room, Linux", 4, 4, "mac", "linux"],
    ["1/2 against 1/2 is a tie: Linux", 2, 2, "balance", "linux"],
    ["1/1 against 1/2: Linux", 1, 1, "balance", "linux"],
  ] as const)("balance by wait: %s", (_, maxRunning, mac, policy, route) => {
    const plan = planRoutes(
      input(
        [...macJobs(mac), ...linuxJobs(2), a()],
        { runnerWhere: "linux", runnerLinuxFull: policy },
        { health: READ, maxRunning, runnerOn: true },
      ),
    );
    expect(plan.routes.a).toBe(route);
    if (policy === "balance") {
      const reason = route === "mac" ? LINUX_FULL_SHORTER : LINUX_FULL_WAITING;
      expect(plan.reasons.a?.split(" · ")[0]).toBe(reason);
    }
  });

  // A move is for good: only a Mac short of slots alone may take it, never one holding it back.
  it.each([
    ["memory pressure", { ...CALM, pressureLevel: 2 }],
    ["the job's own memory", { ...CALM, availableMemoryBytes: 7 * GIB }],
  ] as const)("free Mac slots holding the job back for %s: no move", (_, sample) => {
    for (const policy of ["mac", "balance"] as const) {
      const plan = planRoutes(
        input(
          [...macJobs(1), ...linuxJobs(2), a()],
          { runnerWhere: "linux", runnerLinuxFull: policy },
          { health: READ, maxRunning: 3, runnerOn: true, sample },
        ),
      );
      expect(plan.routes.a).toBe("linux");
      expect(plan.moved).toEqual({});
    }
  });

  it.each([
    ["asked for Linux", a({ where: "linux", linuxOnly: true } as never), {}, READ, "linux-wait"],
    ["Start now", a({ forced: true }), {}, READ, "linux-start"],
    // Slots never hold a call: only limits do.
    ["a job's own call", a({ where: "linux", call: true } as never), {}, OVERLOADED, "linux-wait"],
    ["the user chose to wait for Linux", a({ route: "linux" }), {}, READ, "linux-wait"],
    ["the queue paused", a(), { paused: true }, READ, "linux-wait"],
    ["a Runner set to this Mac", a({ where: "linux" }), { mode: "mac" }, READ, "linux-wait"],
    ["Linux offline", a(), {}, OFFLINE, "ask"],
    [
      "an unconfirmed run",
      a({ unconfirmed: true, dropped: true } as never),
      {},
      READ,
      "linux-wait",
    ],
  ] as const)("%s: never moves, whatever the policy", (_, entry, over, health, outcome) => {
    for (const policy of ["mac", "balance"] as const) {
      const plan = planRoutes(
        input(
          [...linuxJobs(2), entry],
          {
            runnerWhere: "mode" in over ? over.mode : "linux",
            runnerLinuxFull: policy,
          },
          { health, runnerOn: true, ...("paused" in over ? { paused: true } : {}) },
        ),
      );
      expect(outcomeOf(plan, "a")).toBe(outcome);
      expect(plan.reasons.a ?? "").not.toMatch(/^Linux is full/);
    }
  });
});

describe("the Mac↔Linux link", () => {
  const sample = (
    over: Partial<typeof CALM> & { pressureLevel?: number; swapInBytesPerSecond?: number },
  ) => ({
    ...CALM,
    ...over,
  });
  const SWAPPING = 96 * 1024 ** 2;

  it.each([
    ["no reading", null, 3],
    ["calm", sample({ pressureLevel: 1 }), 3],
    ["swapping", sample({ pressureLevel: 1, swapInBytesPerSecond: SWAPPING }), 6],
    ["pressure warning", sample({ pressureLevel: 2 }), 6],
    [
      "pressure warning and swapping",
      sample({ pressureLevel: 2, swapInBytesPerSecond: SWAPPING }),
      6,
    ],
    ["pressure critical", sample({ pressureLevel: 4 }), 12],
  ] as const)("with %s here, ssh gets %is to connect", (_, reading, seconds) => {
    expect(linkMachine(DEFAULT_MACHINE_CONFIG, reading).runnerSshTimeoutSeconds).toBe(seconds);
  });

  const fail = { ok: false as const, error: "remoto could not reach Linux" };
  const ok = { ok: true as const, reading: parseHeartbeat("0.5 0.4 0.3 1/2 3\n6\n") };
  const BEAT = DEFAULT_MACHINE_CONFIG.runnerHeartbeatSeconds * 1000;
  const healthAfter = (
    checks: ReadonlyArray<readonly [number, HealthCheck]>,
    machine = DEFAULT_MACHINE_CONFIG,
  ) =>
    checks.reduce<LinuxHealth>(
      (health, [at, check]) => nextHealth(health, check, machine, 20_000, NOW + at),
      {
        ...ONLINE,
        okAt: NOW - BEAT,
      },
    );

  it.each([
    ["one failure", [[0, fail]], true, 1, 2],
    ["one failure, set to go offline after one", [[0, fail]], true, 1, 1],
    [
      "two jobs failing together",
      [
        [0, fail],
        [400, fail],
      ],
      true,
      1,
      2,
    ],
    [
      "a heartbeat failing with a job",
      [
        [0, fail],
        [BEAT / 2 - 1, fail],
      ],
      true,
      1,
      2,
    ],
    [
      "a failure, then the heartbeat gets through",
      [
        [0, fail],
        [2000, ok],
      ],
      true,
      0,
      2,
    ],
    [
      "failures a heartbeat apart",
      [
        [0, fail],
        [BEAT, fail],
      ],
      false,
      2,
      2,
    ],
  ] as const)("%s: online %s, %i failures counted", (_, checks, online, failures, after) => {
    const machine = { ...DEFAULT_MACHINE_CONFIG, runnerOfflineAfterFailures: after };
    expect(healthAfter(checks as never, machine)).toMatchObject({ online, failures });
  });

  const plannedWith = (
    entry: Partial<QueuedEntry>,
    config: Partial<RunnerProjectConfig>,
    over: Partial<RoutePlanInput> = {},
  ) =>
    outcomeOf(
      planRoutes(
        input([job("a", "vp test run", entry as never)], { runnerWhere: "linux", ...config }, over),
      ),
      "a",
    );
  const STRAINED = { sample: sample({ pressureLevel: 2, swapInBytesPerSecond: SWAPPING }) };

  // Backoff from the ssh timeout (3s), doubling; the third loss counts Linux unavailable.
  it.each([
    [1, 2999, "linux-wait"],
    [1, 3000, "linux-start"],
    [2, 5999, "linux-wait"],
    [2, 6000, "linux-start"],
    [3, 500, "mac-start"],
  ] as const)("after %i lost link(s), %ims later: %s", (linkFailures, ms, outcome) => {
    const entry = { linuxFailedAt: NOW - ms, linkFailures };
    expect(
      plannedWith(
        entry,
        { runnerUnavailable: "mac" },
        // Fresh, and older than every failure: only the backoff sends it back.
        { health: { ...ONLINE, okAt: NOW - 10_000 } },
      ),
    ).toBe(outcome);
  });

  // 40, 42: only an offline Linux "comes back"; online, the row names its own attempts.
  it.each([
    [
      {},
      { okAt: NOW - 60_000 },
      "linux-wait",
      "retrying on Linux (attempt 1 of 3): connection lost",
    ],
    [{ route: "linux" }, { online: false }, "linux-wait", "waiting for Linux to come back"],
    [
      { route: "linux" },
      { okAt: NOW - 60_000 },
      "linux-wait",
      "retrying on Linux (attempt 1 of 3): connection lost",
    ],
    // The first heartbeat through after the failure makes it eligible, with no restart.
    [{ route: "linux" }, { okAt: NOW }, "linux-start", undefined],
  ] as const)("a lost link, %j, Linux %j: %s, %j", (extra, linux, outcome, reason) => {
    const plan = planRoutes(
      input(
        [
          job("a", "vp test run", {
            linuxFailedAt: NOW - 500,
            linkFailures: 1,
            linkError: "connection lost",
            ...extra,
          } as never),
        ],
        { runnerWhere: "linux" },
        { health: { ...ONLINE, ...linux } },
      ),
    );
    expect(outcomeOf(plan, "a")).toBe(outcome);
    expect(plan.reasons.a).toBe(reason);
  });

  const expired = { reason: "unavailable" as const, deadlineAt: ago(1) };
  const DOWN = "Linux is unavailable: running here";
  // Strain only holds a start here: the policy itself applies, and a Mac job waits as any does.
  it.each([
    [
      "unavailable, Run on this Mac",
      { linkFailures: 3 },
      { runnerUnavailable: "mac" },
      ONLINE,
      DOWN,
    ],
    ["Linux offline, Run on this Mac", {}, { runnerUnavailable: "mac" }, OFFLINE, DOWN],
    [
      "dropped, Run on this Mac",
      { dropped: true, linkFailures: 3 },
      { runnerDropped: "mac" },
      ONLINE,
      "Linux dropped it mid-run: running here",
    ],
    [
      "a question nobody answered, Run on this Mac",
      { linkFailures: 3, ask: expired },
      { runnerUnavailable: "ask", runnerDeadlineAction: "mac" },
      ONLINE,
      "Linux is unavailable and nobody answered: running here",
    ],
    [
      "Hybrid with Linux offline",
      {},
      { runnerWhere: "automatic" },
      OFFLINE,
      "Hybrid: Linux is unavailable",
    ],
    ["Linux offline, Ask me", {}, { runnerUnavailable: "ask" }, OFFLINE, "ask"],
    [
      "a question nobody answered, Cancel",
      { linkFailures: 3, ask: expired },
      { runnerUnavailable: "ask", runnerDeadlineAction: "cancel" },
      ONLINE,
      "cancel",
    ],
    [
      "dropped, Tell the agent",
      { dropped: true, linkFailures: 3 },
      { runnerDropped: "agent" },
      ONLINE,
      "cancel",
    ],
  ] as const)("%s, with this Mac strained", (_, failed, config, health, then) => {
    const entry = job("a", "vp test run", { linuxFailedAt: NOW - 500, ...failed } as never);
    const planned = (beside: ReadonlyArray<HeavyQueueEntry>) => {
      const plan = planRoutes(
        input(
          [...beside, entry],
          { runnerWhere: "linux", ...config },
          { health: { ...health, okAt: NOW - 60_000 }, runnerOn: true, ...STRAINED },
        ),
      );
      return { plan, outcome: plan.cancels.a !== undefined ? "cancel" : outcomeOf(plan, "a") };
    };
    const alone = planned([]);
    const busy = planned([runningOn("m", "mac")]);
    if (then === "ask" || then === "cancel") {
      expect([alone.outcome, busy.outcome]).toEqual([then, then]);
      return;
    }
    // The only Mac job always runs; beside another it waits for room, and says why.
    expect([alone.outcome, busy.outcome]).toEqual(["mac-start", "mac-wait"]);
    expect(busy.plan.reasons.a).toBe(`${then} · ${heavyHoldText("pressure", STRAINED.sample, 3)}`);
  });

  it("an environment failure keeps its policy, strained or not", () => {
    const entry = {
      dropped: true,
      failure: "Dependency install on Linux failed",
      linuxFailedAt: NOW - 500,
    };
    const health = { health: { ...ONLINE, okAt: NOW - 100 } };
    expect(plannedWith(entry, { runnerDropped: "mac" }, { ...health, ...STRAINED })).toMatch(
      /^mac-/,
    );
    expect(plannedWith(entry, { runnerDropped: "ask" }, health)).toBe("ask");
  });
});

describe("Linux unavailable, deadline and dropped policies", () => {
  const offline = (entry: HeavyQueueEntry, config: Partial<RunnerProjectConfig>) =>
    planRoutes(input([entry], { runnerWhere: "linux", ...config }, { health: OFFLINE }));
  const asked = (msFromNow: number) => ({
    reason: "unavailable" as const,
    deadlineAt: new Date(NOW + msFromNow).toISOString(),
  });

  it.each([
    ["mac", "mac-start"],
    ["wait", "linux-wait"],
    ["ask", "ask"],
  ] as const)("unavailable: %s → %s", (policy, outcome) => {
    expect(outcomeOf(offline(job("a", "vp test run"), { runnerUnavailable: policy }), "a")).toBe(
      outcome,
    );
  });

  // A job that asked for Linux itself (`--runner linux`) never changes machine; an agent's
  // `remoto` and a Mac job's own nested call (`call`) follow the settings.
  const OFFLINE_ASKED = "Linux is offline and this job asked for Linux";
  it.each([
    [
      "--runner linux, mac",
      "vp test run",
      { where: "linux", linuxOnly: true },
      { runnerUnavailable: "mac" },
      OFFLINE_ASKED,
    ],
    [
      "--runner linux, dropped, agent",
      "vp test run",
      { where: "linux", linuxOnly: true, dropped: true, linkFailures: 3 },
      { runnerDropped: "agent", runnerUnavailable: "wait" },
      "Linux dropped it mid-run, and this job asked for Linux",
    ],
    [
      "--runner linux, dropped, mac",
      "vp test run",
      { where: "linux", linuxOnly: true, dropped: true, linkFailures: 3 },
      { runnerDropped: "mac", runnerUnavailable: "wait" },
      "Linux dropped it mid-run, and this job asked for Linux",
    ],
    [
      "remoto line, mac",
      "remoto vp test run",
      { where: "linux" },
      { runnerUnavailable: "mac" },
      "mac-start",
    ],
    [
      "--now, mac",
      "vp test run",
      { where: "linux", linuxOnly: true, forced: true },
      { runnerUnavailable: "mac" },
      OFFLINE_ASKED,
    ],
    [
      "--runner linux, wait",
      "vp test run",
      { where: "linux", linuxOnly: true },
      { runnerUnavailable: "wait" },
      "linux-wait",
    ],
    [
      "--runner linux, ask",
      "vp test run",
      { where: "linux", linuxOnly: true },
      { runnerUnavailable: "ask" },
      "ask",
    ],
    [
      "--runner linux, unanswered → Mac",
      "vp test run",
      { where: "linux", linuxOnly: true, ask: asked(-1) },
      { runnerUnavailable: "ask", runnerDeadlineAction: "mac" },
      OFFLINE_ASKED,
    ],
    [
      "a Mac job's call, mac",
      "vp test run",
      { where: "linux", call: true },
      { runnerUnavailable: "mac" },
      "mac-start",
    ],
    ["no --runner, mac", "vp test run", {}, { runnerUnavailable: "mac" }, "mac-start"],
    [
      "--runner linux, needs this Mac",
      "xcodebuild test",
      { where: "linux", linuxOnly: true },
      { runnerUnavailable: "mac" },
      "Asked for Linux, but it needs this Mac: Mac-only tool: xcodebuild",
    ],
  ] as const)("asked for Linux: %s, Linux offline → %s", (_, label, fields, config, outcome) => {
    const plan = offline(job("a", label, fields as never), config);
    expect(plan.cancels.a ?? outcomeOf(plan, "a")).toBe(outcome);
  });

  it("asked for Linux and needing this Mac cancels even with Linux up", () => {
    const plan = planRoutes(
      input([job("a", "xcodebuild test", { where: "linux", linuxOnly: true } as never)]),
    );
    expect(plan.cancels.a).toBe(
      "Asked for Linux, but it needs this Mac: Mac-only tool: xcodebuild",
    );
    expect(plan.admits).toEqual({});
  });

  it.each([
    ["mac", "mac-start"],
    ["wait", "linux-wait"],
    ["ask", "ask"],
    ["agent", "cancel"],
  ] as const)(
    "dropped on its last attempt: %s → %s, apart from the unavailable policy",
    (policy, outcome) => {
      const plan = offline(job("a", "vp test run", { dropped: true, linkFailures: 3 } as never), {
        runnerDropped: policy,
        runnerUnavailable: "wait",
      });
      expect(plan.cancels.a !== undefined ? "cancel" : outcomeOf(plan, "a")).toBe(outcome);
      if (outcome === "ask") expect(plan.asks.a).toBe("dropped");
    },
  );

  // Tell the agent hands every failure back, in every mode: nothing reruns on this Mac.
  it.each(
    (["linux", "automatic", "macFirst"] as const).flatMap((where) =>
      (
        [
          [{}, "Linux couldn't run this: Linux dropped it mid-run"],
          [{ failure: "sh: vp: not found" }, "Linux couldn't run this: sh: vp: not found"],
        ] as const
      ).map(([failed, reason]) => [where, failed, reason] as const),
    ),
  )("%s, Tell the agent: %j ends with %j", (where, failed, reason) => {
    const entry = job("a", "vp test run", {
      dropped: true,
      linuxFailedAt: NOW - 500,
      linkFailures: 3,
      ...failed,
    } as never);
    for (const health of [OFFLINE, { ...ONLINE, okAt: NOW - 60_000 }]) {
      const plan = planRoutes(
        input([entry], { runnerWhere: where, runnerDropped: "agent" }, { health }),
      );
      expect(plan.cancels.a).toBe(reason);
      expect(plan.admits).toEqual({});
    }
  });

  // A drop is a lost link: once a heartbeat gets through, the job goes back to Linux by itself,
  // whatever the policy and an open question say.
  it.each([
    ["mac", undefined, "linux-start"],
    ["ask", undefined, "linux-start"],
    ["ask", -1, "linux-start"],
    ["wait", undefined, "linux-start"],
    ["agent", undefined, "linux-start"],
  ] as const)(
    "dropped mid-run, Linux back: %s (question deadline %s) → %s",
    (policy, deadline, outcome) => {
      const plan = planRoutes(
        input(
          [
            job("a", "vp test run", {
              dropped: true,
              linuxFailedAt: NOW - 5000,
              ...(deadline === undefined
                ? {}
                : { ask: { reason: "dropped" as const, deadlineAt: ago(-deadline) } }),
            }),
          ],
          { runnerWhere: "linux", runnerDropped: policy, runnerDeadlineAction: "wait" },
          { health: { ...ONLINE, okAt: NOW - 100 } },
        ),
      );
      expect(outcomeOf(plan, "a")).toBe(outcome);
    },
  );

  // A drop (the link, or the PC going away or restarting) goes back to Linux by itself while it
  // has attempts left: once Linux is up and confirms the run stopped, whatever the policy; with
  // Linux offline, "When Linux is offline" decides, as for any waiter. On its last attempt "If a
  // Linux run fails" acts at once, before Linux can confirm, and Linux coming back undoes nothing.
  const BLIP: LinuxHealth = { ...ONLINE, okAt: NOW - 100 };
  const BACK: LinuxHealth = { ...BLIP, backOnlineAt: NOW - 100 };
  const PC = { "back before offline": BLIP, "still offline": OFFLINE, "back after offline": BACK };
  const pcs = Object.keys(PC) as ReadonlyArray<keyof typeof PC>;
  it.each([
    [1, "agent", "back before offline", "linux-wait", "linux-start"],
    [1, "agent", "back after offline", "linux-wait", "linux-start"],
    [1, "agent", "still offline", "mac-wait", "mac-start"],
    ...pcs.map((pc) => [3, "agent", pc, "cancel", "cancel"] as const),
    ...pcs.map((pc) => [3, "ask", pc, "ask", "ask"] as const),
    ...pcs.map((pc) => [3, "mac", pc, "mac-wait", "mac-start"] as const),
  ] as const)(
    "dropped on attempt %i under %s, PC %s: %s until Linux confirms the run stopped, then %s",
    (linkFailures, policy, pc, unconfirmed, confirmed) => {
      for (const [hold, outcome] of [
        [true, unconfirmed],
        [false, confirmed],
      ] as const) {
        const entry = job("a", "vp test run", {
          dropped: true,
          linuxFailedAt: NOW - 5000,
          linkFailures,
          ...(hold ? { unconfirmed: true } : {}),
        } as never);
        const plan = planRoutes(
          input(
            [entry],
            { runnerWhere: "linux", runnerDropped: policy, runnerUnavailable: "mac" },
            { health: PC[pc] },
          ),
        );
        expect(plan.cancels.a !== undefined ? "cancel" : outcomeOf(plan, "a")).toBe(outcome);
        if (outcome === "ask") expect(plan.asks.a).toBe("dropped");
        if (hold) expect(plan.admits).toEqual({});
        if (outcome === "cancel") {
          expect(plan.cancels.a).toBe(
            hold
              ? "Linux couldn't run this: Linux dropped it mid-run, and hasn't confirmed it stopped there"
              : "Linux couldn't run this: Linux dropped it mid-run",
          );
        }
        if (hold && outcome === "mac-wait") {
          expect(plan.reasons.a).toBe(
            `${linkFailures === 3 ? "Linux dropped it mid-run" : "Linux is unavailable"}: running here once Linux confirms it stopped`,
          );
        }
      }
    },
  );

  // A question asked on the last attempt is the one decision: no second question, and its
  // deadline action reruns only once Linux confirms the run stopped.
  it.each([
    ["open, PC back and confirmed", 60_000, "mac", BACK, false, "linux-wait"],
    ["expired → Mac, PC still away", -1, "mac", OFFLINE, true, "mac-wait"],
    ["expired → Mac, PC back and confirmed", -1, "mac", BACK, false, "mac-start"],
    ["expired → Cancel, PC still away", -1, "cancel", OFFLINE, true, "cancel"],
    ["expired → Wait, PC still away", -1, "wait", OFFLINE, true, "linux-wait"],
    ["expired → Wait, PC back and confirmed", -1, "wait", BACK, false, "linux-start"],
  ] as const)("a drop's question %s: %s", (_, deadline, action, health, hold, outcome) => {
    const entry = job("a", "vp test run", {
      dropped: true,
      linuxFailedAt: NOW - 5000,
      linkFailures: 3,
      ask: { reason: "dropped", deadlineAt: ago(-deadline) },
      ...(hold ? { unconfirmed: true } : {}),
    } as never);
    const plan = planRoutes(
      input(
        [entry],
        { runnerWhere: "linux", runnerDropped: "ask", runnerDeadlineAction: action },
        { health },
      ),
    );
    expect(plan.asks).toEqual({});
    expect(plan.cancels.a !== undefined ? "cancel" : outcomeOf(plan, "a")).toBe(outcome);
    if (hold) expect(plan.admits).toEqual({});
  });

  // A sync the PC took with it never ran there: "When Linux is offline" acts the same way.
  it.each([
    ["mac", "still offline", "mac-wait"],
    ["ask", "still offline", "ask"],
    ["wait", "still offline", "linux-wait"],
    ["mac", "back before offline", "linux-wait"],
  ] as const)("a lost sync under %s, PC %s, before Linux confirms: %s", (policy, pc, outcome) => {
    const entry = job("a", "vp test run", { linuxFailedAt: NOW - 5000, unconfirmed: true });
    const plan = planRoutes(
      input([entry], { runnerWhere: "linux", runnerUnavailable: policy }, { health: PC[pc] }),
    );
    expect(outcomeOf(plan, "a")).toBe(outcome);
    if (outcome === "ask") expect(plan.asks.a).toBe("unavailable");
    expect(plan.admits).toEqual({});
  });

  // An environment failure repeats on every run while Linux stays as it was: under Wait it goes
  // back only once Linux has been offline and come back since, or when the user sends it there.
  it.each([
    ["a heartbeat since", {}, {}, "linux-wait"],
    ["Linux back, but before it failed", {}, { backOnlineAt: NOW - 10_000 }, "linux-wait"],
    ["Linux offline and back since", {}, { backOnlineAt: NOW - 100 }, "linux-start"],
    ["the user sent it to Linux", { route: "linux" as const }, {}, "linux-start"],
    [
      "an expired question that waits",
      { ask: { reason: "dropped" as const, deadlineAt: ago(1) } },
      {},
      "linux-wait",
    ],
  ] as const)("an environment failure under Wait, %s", (_, extra, back, outcome) => {
    const entry = job("a", "vp test run", {
      dropped: true,
      failure: "sh: 1: tsgo: not found",
      linuxFailedAt: NOW - 5000,
      ...extra,
    } as never);
    const plan = planRoutes(
      input(
        [entry],
        { runnerWhere: "linux", runnerDropped: "wait", runnerDeadlineAction: "wait" },
        { health: { ...ONLINE, okAt: NOW - 100, ...back } },
      ),
    );
    expect(outcomeOf(plan, "a")).toBe(outcome);
    if (outcome === "linux-wait") {
      expect(plan.reasons.a).toMatch(/^Linux couldn't run this: sh: 1: tsgo: not found: /);
    }
  });

  it.each([
    [{}, "linux-wait"],
    [{ backOnlineAt: NOW - 100 }, "linux-start"],
  ] as const)("without remoto under Wait, Linux %j: %s", (back, outcome) => {
    const entry = job("a", "vp test run", {
      failure: "remoto is not installed",
      linuxFailedAt: NOW - 5000,
    } as never);
    const plan = planRoutes(
      input(
        [entry],
        { runnerWhere: "linux", runnerUnavailable: "wait" },
        { health: { ...ONLINE, okAt: NOW - 100, ...back } },
      ),
    );
    expect(outcomeOf(plan, "a")).toBe(outcome);
  });

  // An environment failure follows "If a Linux run fails" in every mode, with Linux still online.
  it.each(
    (["linux", "automatic", "macFirst"] as const).flatMap((where) =>
      (
        [
          ["mac", "mac-start", "running here"],
          ["wait", "linux-wait", "waiting for it"],
          ["ask", "ask", "asking you"],
          ["agent", "cancel", null],
        ] as const
      ).map(([policy, outcome, reason]) => [where, policy, outcome, reason] as const),
    ),
  )("%s, environment failure under %s → %s", (where, policy, outcome, reason) => {
    const entry = job("a", "vp test run", {
      dropped: true,
      failure: "sh: 1: tsgo: not found",
      linuxFailedAt: NOW - 5000,
    } as never);
    const plan = planRoutes(
      input(
        [entry],
        { runnerWhere: where, runnerDropped: policy },
        { health: { ...READ, okAt: NOW - 100 }, runnerOn: true },
      ),
    );
    expect(plan.cancels.a !== undefined ? "cancel" : outcomeOf(plan, "a")).toBe(outcome);
    if (outcome === "ask") expect(plan.asks.a).toBe("dropped");
    // The row names the Linux failure, never "Linux is unavailable" while Linux is online.
    if (reason === null)
      expect(plan.cancels.a).toBe("Linux couldn't run this: sh: 1: tsgo: not found");
    else expect(plan.reasons.a).toBe(`Linux couldn't run this: sh: 1: tsgo: not found: ${reason}`);
  });

  it("an open question holds the job until its deadline", () => {
    const plan = offline(job("a", "vp test run", { ask: asked(60_000) }), {});
    expect(plan.asks).toEqual({});
    expect(plan.admits).toEqual({});
    expect(plan.reasons.a).toBe("Linux is unavailable: waiting for your answer");
  });

  it.each([
    ["mac", "mac-start"],
    ["wait", "linux-wait"],
    ["cancel", "cancel"],
  ] as const)("deadline action %s → %s", (action, outcome) => {
    const plan = offline(job("a", "vp test run", { ask: asked(-1) }), {
      runnerDeadlineAction: action,
    });
    expect(plan.cancels.a !== undefined ? "cancel" : outcomeOf(plan, "a")).toBe(outcome);
  });

  it('an answered "Wait for Linux" waits without asking again', () => {
    const plan = offline(job("a", "vp test run", { route: "linux" }), {});
    expect(plan.asks).toEqual({});
    expect(plan.reasons.a).toBe("waiting for Linux to come back");
  });

  // Its lost run holds back only Linux, through its record: work bound for this Mac runs at once,
  // so a Runner turned off, which confirms nothing, never strands it.
  it.each([
    ["bound for Linux", "linux-wait", "vp test run", {}, {}],
    ["with the Runner off", "mac-start", "vp test run", { runnerEnabled: false }, {}],
    ["answered for this Mac", "mac-start", "vp test run", {}, { route: "mac" as const }],
    ["tied to this Mac", "mac-start", "xcodebuild test", {}, {}],
  ] as const)("an unconfirmed drop %s: %s", (_, outcome, label, config, extra) => {
    const plan = planRoutes(
      input([job("a", label, { unconfirmed: true, ...extra })], {
        runnerWhere: "linux",
        ...config,
      }),
    );
    expect(outcomeOf(plan, "a")).toBe(outcome);
    if (outcome === "linux-wait") expect(plan.reasons.a).toMatch(/confirming it stopped/);
  });

  it("before the first heartbeat a Linux job waits instead of asking", () => {
    const plan = planRoutes(
      input([job("a", "vp test run")], { runnerWhere: "linux" }, { health: UNKNOWN_HEALTH }),
    );
    expect(plan.asks).toEqual({});
    expect(plan.reasons.a).toBe("checking whether Linux is up");
  });
});

// A running job's own call never waits for a slot its job holds: A (Mac) calls B (Linux), which
// waits for C (Linux, same worktree), which calls D (Mac). With D waiting on A's slot, none moved.
describe("a running job's own calls", () => {
  const W = "/work/w";
  const call = (id: string, where: "mac" | "linux") =>
    job(id, "vp test run", { cwd: W, where, call: true } as never);
  const full = { ...CALM, availableMemoryBytes: 1 * GIB };
  it.each([
    ["A holds the only Mac slot", "vp run build", CALM, 1],
    ["A runs alone", "xcrun simctl boot iPhone", CALM, 3],
    ["the Mac has no memory for D", "vp run build", full, 3],
  ] as const)("%s: D starts, then B once C ends", (_, aLine, sample, maxRunning) => {
    const a = job("a", aLine, { cwd: W, startedAt: ago(600_000) });
    const c = runningOn("c", "linux", W);
    // Linux's slots are full of other worktrees' jobs: B still starts.
    const others = Array.from({ length: DEFAULT_MACHINE_CONFIG.runnerLinuxSlots }, (_, i) =>
      runningOn(`x${i}`, "linux"),
    );
    const over = { maxRunning, sample };
    const first = planRoutes(input([a, c, call("b", "linux"), call("d", "mac")], {}, over));
    expect(first.admits.d).toEqual({ runner: "mac", ungated: false });
    expect(first.admits.b).toBeUndefined();
    expect(first.reasons.b).toBe("waiting for Linux: this worktree is already running on Linux");
    const d = { ...call("d", "mac"), startedAt: ago(1000) };
    const then = planRoutes(input([a, d, ...others, call("b", "linux")], {}, over));
    expect(then.admits.b).toEqual({ runner: "linux", ungated: false });
  });
});

describe("runtime toggles", () => {
  const entries = [
    runningOn("r", "mac"),
    job("macWaiter", "vp run build"),
    job("linuxWaiter", "vp test run", { route: "linux" }),
  ];

  it("queue off releases Mac waiters and keeps Linux waiters waiting for Linux", () => {
    const plan = planRoutes(
      input(entries, { runnerWhere: "mac" }, { enabled: false, health: OFFLINE }),
    );
    expect(plan.admits.macWaiter).toEqual({ runner: "mac", ungated: true });
    expect(plan.admits.linuxWaiter).toBeUndefined();
    expect(plan.routes.linuxWaiter).toBe("linux");
  });

  it("Runner off sends Linux waiters down the Mac path, and cancels one that asked for Linux", () => {
    const asked = job("asked", "vp test run", { where: "linux", linuxOnly: true } as never);
    const off = planRoutes(
      input([...entries, asked], { runnerEnabled: false }, { health: OFFLINE }),
    );
    expect(off.routes.linuxWaiter).toBe("mac");
    expect(off.cancels.asked).toBe(
      "The Runner is off for this project and this job asked for Linux",
    );
    expect(off.admits.asked).toBeUndefined();
    const offAndNoQueue = planRoutes(
      input(entries, { runnerEnabled: false }, { enabled: false, health: OFFLINE }),
    );
    expect(offAndNoQueue.admits.linuxWaiter).toEqual({ runner: "mac", ungated: true });
  });

  it("never touches what is already running", () => {
    const plan = planRoutes(input(entries, { runnerEnabled: false }, { enabled: false }));
    expect(plan.admits.r).toBeUndefined();
  });

  it("paused holds both runners; a forced job still starts where it was headed", () => {
    const plan = planRoutes(
      input(
        [job("l", "vp test run"), job("f", "vp test run", { forced: true })],
        { runnerWhere: "linux" },
        { paused: true },
      ),
    );
    expect(plan.admits).toEqual({ f: { runner: "linux", ungated: false } });
    expect(plan.reasons.l).toBe("paused");
  });

  it("once a Runner is on, every Mac row says why it stays, beside what it waits for here", () => {
    const entries = [
      job("run", "xcodebuild -scheme App build", { startedAt: ago(1000) }),
      job("install", "pnpm install"),
      job("moved", "vp test run", { route: "mac" }),
      job("back", "vp test run", {
        route: "mac",
        routeReason: "Uses a file only this Mac has: /x",
      } as Partial<HeavyQueueEntry>),
      job("forced", "vp test run", { forced: true }),
    ];
    const at = (over: Partial<RoutePlanInput>, config: Partial<RunnerProjectConfig> = {}) =>
      planRoutes(input(entries, { runnerWhere: "linux", ...config }, { maxRunning: 1, ...over }))
        .reasons;
    expect(at({ runnerOn: true })).toEqual({
      run: "Mac-only tool: xcodebuild",
      install: "Changes this Mac's checkout: pnpm install · the one slot is busy",
      moved: "Moved to this Mac · the one slot is busy",
      back: "Uses a file only this Mac has: /x · the one slot is busy",
    });
    expect(at({ runnerOn: true }, { runnerWhere: "mac" }).install).toMatch(
      /^Changes this Mac's checkout/,
    );
    expect(at({ runnerOn: true, enabled: false }, { runnerEnabled: false })).toMatchObject({
      install: "Runner off for this project",
    });
    // With every Runner off, rows say only what they wait for.
    expect(at({}, { runnerEnabled: false })).toEqual({
      install: "the one slot is busy",
      moved: "the one slot is busy",
      back: "the one slot is busy",
    });
  });
});

describe("patterns and eligibility", () => {
  it.each([
    ["vp test run", "test", true],
    ["pnpm run test:e2e", "e2e", true],
    ["pnpm run test:e2e", "test", true],
    ["vp run check:changed", "check", true],
    ["npm i latest", "test", false],
    ["vitest run", "test", false],
    ["vp test run src/device/CaptureDevices.test.ts", "CaptureDevices.test.ts", true],
    ["vp test run src/device/CaptureDevices.test.ts", "src/device/*", true],
    ["npx expo run:ios", "expo run", true],
    ["EXPO run:ios", "expo run", true],
    ["vp test", "  ", false],
    ["pnpm exec effect-tsgo tsrs --noEmit", "typecheck", true],
    ["vue-tsc --noEmit", "tsc", true],
    ["tsgo --noEmit", "test", false],
    // A pattern named like an object's own key matches as written.
    ["vp test run", "constructor", false],
    ["toString x", "toString", true],
  ])("%s matches %s: %s", (text, pattern, result) => {
    expect(matchesAny(text, [pattern])).toBe(result);
  });

  const at = { config: DEFAULT_PROJECT_CONFIG, home: "/home/me", rootOf: () => "/w" };
  it.each([
    ["vp test run", "linux", null],
    ["vp run typecheck && vp run lint", "linux", null],
    ["vp run build && vp test run", "linux", null],
    ["pnpm run build", "linux", null],
    ["xcodebuild -scheme App test", "mac-only", "Mac-only tool: xcodebuild"],
    ["vp run dev:desktop", "mac-only", "Serves a port used here: vp dev:desktop"],
    ["echo hi", "linux", null],
    ["./scripts/ci.sh", "linux", null],
    ["vp run check:changed", "linux", null],
    ["timeout 3500 vp run check:changed origin/main", "linux", null],
    ["vp test run --changed", "linux", null],
    ["npx jest --onlyChanged", "linux", null],
    ["remoto /usr/bin/git status", "linux", null],
    ["vp test run src/changed.test.ts src/staged/a.test.ts", "linux", null],
    ['vp test run src/a.test.ts -t "the title changed"', "linux", null],
    // A folder flag with no folder after it moves nothing.
    ["pnpm -C", "linux", null],
  ])("%s is %s by default", (label, eligibility, reason) => {
    expect(eligibilityOf({ label, cwd: "/w" }, at)).toMatchObject({ eligibility, reason });
  });

  // Not following a command, or what its shell set up, is no reason to keep it here.
  it.each(
    (
      [
        [".venv/bin/pytest -q", "linux", null],
        ["uv run pytest", "linux", null],
        ["source .venv/bin/activate && vp test run", "linux", null],
        ["nvm use 22 && vp test run", "linux", null],
        ['eval "$(direnv export bash)" && vp test run', "linux", null],
        ["node dist/cli.js test", "linux", null],
        ["./tools/check", "linux", null, { "./tools/check": "#!/usr/bin/env python3\nprint(1)" }],
        ["vp test run /w/src/a.test.ts", "linux", null],
        [
          "vp test run /Users/me/other/a.test.ts",
          "mac-only",
          "Uses a file only this Mac has: /Users/me/other/a.test.ts",
        ],
        ["cd /w/apps/web && vp test run src/a.test.ts", "linux", null],
      ] as ReadonlyArray<
        readonly [string, string, string | null, Readonly<Record<string, string | null>>?]
      >
    ).map(([label, eligibility, reason, scripts]) => ({ label, eligibility, reason, scripts })),
  )("$label is $eligibility", ({ label, eligibility, reason, scripts }) => {
    expect(
      eligibilityOf({ label, cwd: "/w", ...(scripts === undefined ? {} : { scripts }) }, at),
    ).toMatchObject({ eligibility, reason });
  });

  // Every mode, even with nothing on Always on this Mac; only port 5733 listens here.
  const open = {
    ...at,
    config: { ...DEFAULT_PROJECT_CONFIG, runnerMacOnly: [] },
    listening: (port: number) => port === 5733,
  };
  it.each([
    ["pnpm install", "mac-state", "pnpm install"],
    ["vp i", "mac-state", "vp i"],
    ["npm ci", "mac-state", "npm ci"],
    ["yarn add react", "mac-state", "yarn add"],
    ["pnpm --filter web remove lodash", "mac-state", "pnpm remove"],
    ["xcodebuild -scheme App test", "mac-tool", "xcodebuild"],
    ["adb install app.apk", "mac-tool", "adb"],
    ["pnpm exec next start", "serves-port", "next start"],
    ["vp run dev", "serves-port", "vp dev"],
    ["pnpm start", "serves-port", "pnpm start"],
    ["npx vite", "serves-port", "vite"],
    ["npx next dev", "serves-port", "next dev"],
    ["cargo build --release", "native-build", "cargo build"],
    ["cargo +nightly clippy", "native-build", "cargo clippy"],
    ["swift build -c release", "native-build", "swift build"],
    ["go test ./...", "native-build", "go test"],
    ["codesign --verify dist/T3.app", "native-build", "codesign"],
    ["make -C native/x", "native-build", "make"],
    ["pnpm exec cmake --build build", "native-build", "cmake"],
    ["sh -c 'cd native && clang++ -O2 a.cc'", "native-build", "clang++"],
    ["pnpm exec playwright test --base-url http://127.0.0.1:5733", "mac-port", "localhost:5733"],
    ["curl -s --url=http://[::1]:5733/api", "mac-port", "localhost:5733"],
    ["pnpm exec vitest --ui", "serves-port", "vitest --ui"],
    ["pnpm -F web exec playwright test --ui", "serves-port", "playwright --ui"],
    ["pnpm exec turbo run dev", "serves-port", "turbo dev"],
    ["nx run web:serve", "serves-port", "nx web:serve"],
    ["jest --watch", "watches", "jest --watch"],
    ["pnpm exec vitest -w", "watches", "vitest -w"],
    ["vitest watch", "watches", "vitest watch"],
    ["docker build -t app .", "mac-docker", "docker build"],
    ["docker compose exec db psql", "mac-docker", "docker compose"],
    ["T3CODE_HOME=/home/me/.t3/dev vp test run", "mac-env", "/home/me/.t3/dev"],
    ["T3CODE_HOME=~/.t3/dev vp test run", "mac-env", "/home/me/.t3/dev"],
    ["env CLAUDE_CONFIG_DIR=/home/me/.claude vp test run", "mac-env", "/home/me/.claude"],
    [
      "export DATABASE_URL=postgres://u@localhost:5733/db; vp test run",
      "mac-port",
      "localhost:5733",
    ],
    ["BASE_URL=http://localhost:5733 pnpm exec playwright test", "mac-port", "localhost:5733"],
  ] as const)("%s stays on this Mac whatever the lists say", (label, code, subject) => {
    expect(eligibilityOf({ label, cwd: "/w" }, open)).toEqual({
      eligibility: "mac-only",
      reason: macReasonText({ code, subject }),
      mac: { code, subject },
    });
  });
  it("takes its Mac-only tools from the settings", () => {
    const tools = { ...at, config: { ...open.config, runnerMacTools: ["fastlane"] } };
    expect(eligibilityOf({ label: "fastlane beta", cwd: "/w" }, tools)).toMatchObject({
      reason: "Mac-only tool: fastlane",
    });
    expect(eligibilityOf({ label: "adb devices", cwd: "/w" }, tools).eligibility).toBe("linux");
  });

  it.each([
    "vp test run",
    "npx vite build",
    "pnpm run build",
    "./scripts/ci.sh",
    "cargo fmt --check",
    "go mod tidy",
    "pnpm exec playwright test --base-url http://localhost:4173",
    "pnpm -w exec vitest run",
    "turbo run build --filter web",
    "docker --version",
    "CI=1 NODE_OPTIONS=--max-old-space-size=8192 vp test run",
    "S=/tmp/x; vp test run",
    "DATABASE_URL=postgres://localhost:5432/db vp test run",
    "PATH=/opt/bin:$PATH vp test run",
    "jest -w 4",
  ])("%s may still leave", (label) => {
    expect(eligibilityOf({ label, cwd: "/w" }, open).eligibility).toBe("linux");
  });

  // The queue read each script when the job was queued; the Runner judges its text.
  it.each([
    ["vp test run", "linux", null],
    ["cd sub && vp run lint", "linux", null],
    ["vp run build", "linux", null],
    ["git add . && git commit -m x", "mac-only", "Changes this Mac's checkout: git commit"],
    ["vp test run /etc/hosts", "mac-only", "Uses a file only this Mac has: /etc/hosts"],
    [null, "mac-only", "Uses a file only this Mac has: /tmp/s/v.sh"],
  ] as const)("a script outside the project running %j is %s", (body, eligibility, reason) => {
    for (const label of ["bash /tmp/s/v.sh", "/tmp/s/v.sh --fast"]) {
      const scripts = { "/tmp/s/v.sh": body };
      expect(eligibilityOf({ label, cwd: "/w", scripts }, at)).toMatchObject({
        eligibility,
        reason,
      });
    }
  });

  // Shapes of the eight jobs a strained Mac held while Linux idled, and their counter-cases.
  const SHIM =
    '#!/bin/sh\ncase `uname -a` in\n  *CYGWIN*) exe=".exe" ;;\nesac\nexec node "$basedir/vp" "$@"\n';
  const GATE =
    '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\nif [ -n "${CI:-}" ]; then echo ci; fi\nvp lint --no-ignore src/a.ts\nfor p in apps/server apps/web; do (cd $p && vp test run); done\n';
  it.each([
    ["vp fmt a.ts b.tsx && vp lint --no-ignore a.ts b.tsx", {}, "linux", null],
    ['f=(a.ts); vp fmt "${f[@]}" && vp test run src/a.test.ts', {}, "linux", null],
    [
      "cd apps/server && pnpm exec vp fmt src/x.ts && pnpm exec effect-tsgo tsrs --noEmit",
      {},
      "linux",
      null,
    ],
    ["vp run fmt src/a.ts; vp run typecheck", {}, "linux", null],
    [
      'for f in $(git diff --name-only HEAD); do vp fmt --stdin-filepath=$f < $f | cmp -s - $f || echo "fmt diff $f"; done; vp lint --no-ignore a.ts',
      {},
      "linux",
      null,
    ],
    // A formatter that only checks the whole tree writes nothing: a check like any other.
    ["vp fmt --check && vp test run", {}, "linux", null],
    // A package's bin is a launcher, judged by the program it starts.
    [
      "./node_modules/.bin/vp lint --no-ignore apps/web/src/a.tsx",
      { "./node_modules/.bin/vp": SHIM },
      "linux",
      null,
    ],
    // A script inside a `sh -c` text is judged by the text the job carries, not its name.
    ["sh -c 'cd apps/web && ./gate.sh'", { "./gate.sh": GATE }, "linux", null],
    // A formatter writing the whole tree, and a build, go there too.
    ["vp fmt && vp lint", {}, "linux", null],
    ["sh -c './gate.sh'", { "./gate.sh": "vp lint\nvp run build\n" }, "linux", null],
    // A script it can't read is no reason to keep it here.
    ["sh -c './gate.sh'", {}, "linux", null],
  ] as const)("%s is %s", (label, scripts, eligibility, reason) => {
    expect(eligibilityOf({ label, cwd: "/w", scripts }, at)).toMatchObject({ eligibility, reason });
  });

  it("a job the hook queued on this Mac shows why", () => {
    const entry = {
      ...job("s", "bash missing.sh"),
      where: "mac" as const,
      routeReason: "Uses a file only this Mac has: /x",
    };
    const plan = planRoutes(input([entry], {}, { runnerOn: true }));
    expect(plan.reasons.s).toContain("Uses a file only this Mac has: /x");
  });

  it("judges the full line a long label was cut from, and device opens held by a server", () => {
    const line = `vp test run ${"a".repeat(200)} /etc/hosts`;
    expect(eligibilityOf({ label: line.slice(0, 200), line, cwd: "/w" }, at)).toMatchObject({
      eligibility: "mac-only",
      reason: "Uses a file only this Mac has: /etc/hosts",
    });
    expect(eligibilityOf({ label: "Open iPhone", server: true, cwd: "/w" }, at)).toEqual({
      eligibility: "exclusive",
      reason: "Always on this Mac: Open iPhone",
    });
  });

  it.each([
    ["mac-tool", "xcodebuild", "Mac-only tool: xcodebuild"],
    ["mac-env", "~/.t3/userdata", "Uses a file only this Mac has: ~/.t3/userdata"],
    ["mac-state", "git commit", "Changes this Mac's checkout: git commit"],
    ["mac-repo", "git push", "Uses this Mac's git repository: git push"],
    ["pinned", "--runner mac", "Pinned to this Mac: --runner mac"],
    ["serves-port", "vite", "Serves a port used here: vite"],
    [
      "learned",
      "sh: 1: vp: not found, 2026-11-18",
      "Linux couldn't run this before: sh: 1: vp: not found, 2026-11-18",
    ],
  ] as const)("a %s reason reads as its code and subject", (code, subject, text) => {
    expect(macReasonText({ code, subject })).toBe(text);
  });

  it("finds Mac-only test files in a failed run's output", () => {
    const output = "✓ a.test.ts\n FAIL src/device/CaptureDevices.test.ts > lists\nFAIL x\n";
    expect(platformFailures(output, ["xcodebuild", "CaptureDevices.test.ts"])).toEqual([
      "FAIL src/device/CaptureDevices.test.ts > lists",
    ]);
    expect(platformFailures(output, ["xcodebuild"])).toEqual([]);
  });
});

describe("project settings over global", () => {
  const config = (minutes: number) => ({ ...DEFAULT_PROJECT_CONFIG, runnerAskMinutes: minutes });
  const block: RunnerBlock = {
    global: config(3),
    machine: DEFAULT_MACHINE_CONFIG,
    projects: [
      { root: "/code/app", config: config(5) },
      { root: "/code/app/packages/inner", config: config(7) },
    ],
    publisher: { pid: 1, home: "/h", primary: true },
  };

  it.each([
    ["/code/app/src", [], 5],
    ["/code/app/packages/inner/src", [], 7],
    ["/code/other", [], 3],
    ["/code/application", [], 3],
    // A worktree outside the project folder resolves through its main checkout.
    ["/Users/me/.t3/worktrees/app/t3-1/src", ["/code/app/src"], 5],
  ] as const)("%s uses the deepest project's settings", (cwd, aliases, minutes) => {
    expect(runnerConfigFor(block, cwd, aliases).runnerAskMinutes).toBe(minutes);
  });

  it("no published block reads as the defaults, Runner off", () => {
    expect(runnerConfigFor(null, "/x")).toEqual(DEFAULT_PROJECT_CONFIG);
    expect(DEFAULT_PROJECT_CONFIG.runnerEnabled).toBe(false);
  });
});

describe("who publishes the Runner block", () => {
  const current = (pid: number, home: string, primary: boolean): RunnerBlock => ({
    global: DEFAULT_PROJECT_CONFIG,
    machine: DEFAULT_MACHINE_CONFIG,
    projects: [],
    publisher: { pid, home, primary },
  });
  const alive = (pid: number) => pid === 10;

  it.each([
    ["no block yet", null, { pid: 2, home: "/dev", primary: false }, true],
    ["same home", current(10, "/dev", false), { pid: 2, home: "/dev", primary: false }, true],
    [
      "live app vs dev server",
      current(10, "/app", true),
      { pid: 2, home: "/dev", primary: false },
      false,
    ],
    ["dead owner", current(9, "/app", true), { pid: 2, home: "/dev", primary: false }, true],
    [
      "app over live dev server",
      current(10, "/dev", false),
      { pid: 2, home: "/app", primary: true },
      true,
    ],
  ] as const)("%s → %s", (_name, block, next, result) => {
    expect(mayPublish(block, next, alive)).toBe(result);
  });
});

describe("Linux health", () => {
  it("goes offline only after the configured failures and back after one success", () => {
    const fail = { ok: false as const, error: "timeout" };
    const ok = { ok: true as const, reading: parseHeartbeat("0.5 0.4 0.3 1/2 3\n6\n") };
    const machine = { ...DEFAULT_MACHINE_CONFIG, runnerOfflineAfterFailures: 3 };
    const beat = (n: number) => n * machine.runnerHeartbeatSeconds * 1000;
    let health = nextHealth(UNKNOWN_HEALTH, fail, machine, 20_000, beat(1));
    expect(health).toMatchObject({ online: null, failures: 1 });
    health = nextHealth(health, fail, machine, 20_000, beat(2));
    expect(health.online).toBeNull();
    health = nextHealth(health, fail, machine, 20_000, beat(3));
    expect(health).toMatchObject({ online: false, failures: 3, error: "timeout" });
    health = nextHealth(health, ok, machine, 20_000, beat(4));
    expect(health).toMatchObject({
      online: true,
      failures: 0,
      okAt: beat(4),
      backOnlineAt: beat(4),
      load1: 0.5,
      cpuCount: 6,
    });
    // Only coming back from offline moves it, not every good beat.
    health = nextHealth(health, fail, machine, 20_000, beat(5));
    expect(health).toMatchObject({ online: true, failures: 1, backOnlineAt: beat(4) });
    expect(nextHealth(health, ok, machine, 20_000, beat(6))).toMatchObject({
      okAt: beat(6),
      backOnlineAt: beat(4),
    });
  });

  describe("over its limits only on sustained readings", () => {
    const WINDOW = 20_000;
    const BEAT = DEFAULT_MACHINE_CONFIG.runnerHeartbeatSeconds * 1000;
    const reading = (freeGib: number, cpuPercent = 8, load1 = 0.5) => ({
      ok: true as const,
      reading: {
        cpuPercent,
        load1,
        cpuCount: 6,
        availableMemoryBytes: freeGib * GIB,
        totalMemoryBytes: 12 * GIB,
      },
    });
    /** Folds heartbeats `[atMs, check]` from unknown health; the verdict after each. */
    const verdicts = (beats: ReadonlyArray<readonly [number, HealthCheck]>) => {
      let health = UNKNOWN_HEALTH;
      return beats.map(([at, check]) => {
        health = nextHealth(health, check, DEFAULT_MACHINE_CONFIG, WINDOW, at);
        return health.overLimit;
      });
    };
    const low = reading(1);
    const fine = reading(8);
    const busy = reading(8, 90);
    // 17/11: load 34.7 on 6 cores while `top` showed the PC 98% idle.
    const queued = reading(8, 2, 34.7);

    it.each([
      [
        "one low-memory heartbeat is a spike",
        [
          [0, fine],
          [BEAT, low],
          [2 * BEAT, fine],
        ],
        [false, false, false],
      ],
      [
        "two in a row at the default beat and window move it",
        [
          [0, low],
          [BEAT, low],
        ],
        [false, true],
      ],
      [
        "a busy CPU counts the same",
        [
          [0, busy],
          [BEAT, busy],
        ],
        [false, true],
      ],
      [
        "a high load on an idle CPU never counts",
        [
          [0, queued],
          [BEAT, queued],
          [2 * BEAT, queued],
        ],
        [false, false, false],
      ],
      [
        "one good heartbeat does not bring it back",
        [
          [0, low],
          [BEAT, low],
          [2 * BEAT, fine],
        ],
        [false, true, true],
      ],
      [
        "two good heartbeats in a row do",
        [
          [0, low],
          [BEAT, low],
          [2 * BEAT, fine],
          [3 * BEAT, fine],
        ],
        [false, true, true, false],
      ],
      [
        "a failed check in between keeps the run",
        [
          [0, low],
          [BEAT, { ok: false, error: "x" }],
          [2 * BEAT, low],
        ],
        [false, false, true],
      ],
      [
        "a long silence starts over",
        [
          [0, low],
          [10 * BEAT, low],
        ],
        [false, false],
      ],
      [
        "a heartbeat without numbers never counts as over",
        [
          [0, reading(Number.NaN)],
          [BEAT, { ok: true, reading: parseHeartbeat("") }],
        ],
        [false, false],
      ],
    ] as const)("%s", (_name, beats, expected) => {
      expect(verdicts(beats as ReadonlyArray<readonly [number, HealthCheck]>)).toEqual(expected);
    });
  });

  /** `HEARTBEAT_COMMAND` output with `/proc/stat`'s `cpu` line before and after. */
  const heartbeat = (load: string, before: string, after: string) =>
    [
      `${load} 0.80 0.50 2/400 1234`,
      "6",
      "               total        used        free      shared  buff/cache   available",
      "Mem:     12000000000  3000000000  6000000000     1000000  3000000000  8500000000",
      "Swap:     4000000000           0  4000000000",
      before,
      after,
    ].join("\n");
  const STAT = "cpu  2255340 3412 2290112 22625563 6290 0 4562 0 0 0";

  it.each([
    // 300 jiffies (6 cores, half a second): 6 busy, 294 idle, though the load is 34.7.
    [
      "an idle PC with a high load",
      "34.70",
      "cpu  2255344 3412 2290114 22625857 6290 0 4562 0 0 0",
      2,
    ],
    ["a busy PC", "5.40", "cpu  2255540 3412 2290182 22625583 6290 0 4572 0 0 0", 93.3],
    [
      "waiting on disk is not busy",
      "8.00",
      "cpu  2255400 3412 2290112 22625753 6340 0 4562 0 0 0",
      20,
    ],
    ["steal is busy", "1.00", "cpu  2255340 3412 2290112 22625713 6290 0 4562 150 0 0", 50],
    // Guest time already sits inside user: counting it again would pass 100%.
    ["guest time once", "1.00", "cpu  2255640 3412 2290112 22625563 6290 0 4562 0 300 0", 100],
    ["counters that did not move", "1.00", STAT, null],
    ["counters that went back (a reboot)", "1.00", "cpu  10 0 10 1000 0 0 0 0 0 0", null],
    ["a missing second line", "1.00", "", null],
  ] as const)("reads CPU in use from /proc/stat: %s", (_name, load, after, cpu) => {
    const reading = parseHeartbeat(heartbeat(load, STAT, after));
    expect(reading.cpuPercent === null ? null : Math.round(reading.cpuPercent * 10) / 10).toBe(cpu);
    expect(reading.load1).toBe(Number(load));
  });

  it("a PC idle under a high load takes an eligible job", () => {
    const idle = {
      ok: true as const,
      reading: parseHeartbeat(
        heartbeat("34.70", STAT, "cpu  2255344 3412 2290114 22625857 6290 0 4562 0 0 0"),
      ),
    };
    const beat = DEFAULT_MACHINE_CONFIG.runnerHeartbeatSeconds * 1000;
    const health = [0, 1, 2].reduce<LinuxHealth>(
      (health, at) =>
        nextHealth(health, idle, DEFAULT_MACHINE_CONFIG, 20_000, NOW - 3 * beat + at * beat),
      { ...UNKNOWN_HEALTH, online: true },
    );
    const plan = planRoutes(input([job("a", "vp test run")], { runnerWhere: "linux" }, { health }));
    expect(outcomeOf(plan, "a")).toBe("linux-start");
  });

  // A server or PC without the `/proc/stat` lines reads no CPU: unknown never holds jobs back.
  it("a heartbeat with no CPU reading and a high load takes an eligible job", () => {
    const blind = { ok: true as const, reading: parseHeartbeat(heartbeat("34.70", "", "")) };
    expect(blind.reading.cpuPercent).toBeNull();
    const beat = DEFAULT_MACHINE_CONFIG.runnerHeartbeatSeconds * 1000;
    const health = [0, 1, 2].reduce<LinuxHealth>(
      (health, at) =>
        nextHealth(health, blind, DEFAULT_MACHINE_CONFIG, 20_000, NOW - 3 * beat + at * beat),
      { ...UNKNOWN_HEALTH, online: true },
    );
    expect(health.overLimit).toBe(false);
    const plan = planRoutes(input([job("a", "vp test run")], { runnerWhere: "linux" }, { health }));
    expect(outcomeOf(plan, "a")).toBe("linux-start");
  });

  it("reads load, cores and memory from the heartbeat output", () => {
    const text = [
      "1.25 0.80 0.50 2/400 1234",
      "6",
      "               total        used        free      shared  buff/cache   available",
      "Mem:     12000000000  3000000000  6000000000     1000000  3000000000  8500000000",
      "Swap:     4000000000           0  4000000000",
    ].join("\n");
    expect(parseHeartbeat(text)).toEqual({
      cpuPercent: null,
      load1: 1.25,
      cpuCount: 6,
      totalMemoryBytes: 12_000_000_000,
      availableMemoryBytes: 8_500_000_000,
    });
    // `/proc/uptime` comes last: seconds since boot, then idle time.
    expect(parseHeartbeat(`${text}\n300.25 1650.10`)).toEqual({
      cpuPercent: null,
      load1: 1.25,
      cpuCount: 6,
      totalMemoryBytes: 12_000_000_000,
      availableMemoryBytes: 8_500_000_000,
      uptimeSeconds: 300.25,
    });
    expect(parseHeartbeat("garbage")).toEqual({
      cpuPercent: null,
      load1: null,
      cpuCount: null,
      totalMemoryBytes: null,
      availableMemoryBytes: null,
    });
  });

  it("builds ssh calls from the machine settings and REMOTO_SSH_OPTS", () => {
    expect(
      sshArgs(
        { ...DEFAULT_MACHINE_CONFIG, runnerSshTimeoutSeconds: 7, runnerHost: "pc" },
        {
          REMOTO_SSH_OPTS: " -p 2222  -i key ",
        },
        "true",
      ),
    ).toEqual([
      "-o",
      "ConnectTimeout=7",
      "-o",
      "BatchMode=yes",
      "-p",
      "2222",
      "-i",
      "key",
      "pc",
      "true",
    ]);
  });
});

describe("Linux runs a reading stops", () => {
  const at = (id: string, startedAgo: number, extra: Partial<QueuedEntry> = {}) => ({
    ...runningOn(id, "linux"),
    startedAt: ago(startedAgo),
    ...extra,
  });
  // Half the 20% floor: below 10% free the newest run stops.
  const EVICT = (DEFAULT_MACHINE_CONFIG.runnerLinuxMemoryFloorPercent / 100) * LINUX_EVICT_SHARE;
  const free = (share: number): LinuxHealth => ({
    ...READ,
    availableMemoryBytes: share * 12 * GIB,
  });
  const three = [at("old", 900_000), at("mid", 600_000), at("new", 300_000)];
  it.each([
    ["8% free beside two others", free(EVICT - 0.02), three, { new: "memory" }],
    ["8% free with one run", free(EVICT - 0.02), [at("only", 300_000)], {}],
    [
      "8% free while one already stops for memory",
      free(EVICT - 0.02),
      [at("old", 900_000), at("mid", 600_000, { stop: "memory" }), at("new", 300_000)],
      {},
    ],
    [
      "8% free, with no reading since the last stop",
      free(EVICT - 0.02),
      [...three, job("gone", "vp test run", { evictedAt: NOW - 1000 } as never)],
      {},
    ],
    ["15% free", free(EVICT + 0.05), three, {}],
    // The reading is a second old: Linux booted 301 s ago.
    [
      "Linux booted 300 s before the reading",
      { ...READ, uptimeSeconds: 300 },
      [at("before", 601_000), at("after", 101_000)],
      { before: "reboot" },
    ],
  ] as const)("%s", (_, health, entries, stops) => {
    expect(linuxStops(health, entries, DEFAULT_MACHINE_CONFIG)).toEqual(stops);
  });
});

describe("an install unfinished in a fresh Linux copy", () => {
  it.each([
    [
      "failed to create directory '/home/dev/runs/t3-1a2b3c4d/node_modules/.pnpm/electron@44.10.1_supports-color@8.1.1/node_modules/electron/dist/locales': File exists (os error 17)",
      "electron",
    ],
    [
      'Error: Electron failed to install correctly. Please delete `node_modules/electron` and run "npx install-electron --no" manually.',
      "electron",
    ],
    [
      "browserType.launch: Executable doesn't exist at /home/dev/.cache/ms-playwright/chromium-1200/chrome-linux/chrome",
      "playwright",
    ],
    ["Error: Could not find Chrome (ver. 131.0.6778.85). This can occur if either", "puppeteer"],
    ["The cypress npm package is installed, but the Cypress binary is missing.", "cypress"],
    [
      "Error: EEXIST: file already exists, mkdir '/home/dev/runs/a/node_modules/@scope/tool/bin'",
      "@scope/tool",
    ],
    ["Error: EEXIST: file already exists, mkdir 'node_modules/sharp/vendor'", "sharp"],
    // The code's own failures, even ones about files that exist.
    ["AssertionError: expected 1 to be 2", null],
    ["Error: EEXIST: file already exists, mkdir '/tmp/out'", null],
    ["FAIL src/node_modules.test.ts > writes the folder", null],
    // Text that only quotes one: a test runner listing test names, a command echoed as data.
    [
      '     \u001b[2m\u001b[90m↓\u001b[39m\u001b[22m an install that really fails while installing is an install failure of ["echo \\"Error: EEXIST: file already exists, mkdir \'node_modules/sharp/vendor\'\\" >&2"]',
      null,
    ],
    ["  ✓ Electron failed to install correctly reruns once", null],
    // An installer's own error, miette style.
    [
      "  × failed to create directory '/home/dev/runs/a/node_modules/.pnpm/electron@44.10.1/node_modules/electron/dist': File exists (os error 17)",
      "electron",
    ],
    ['  × reports "Error: Could not find Chrome (ver. 1)" as puppeteer', null],
  ] as const)("%j is an install failure of %j", (line, pkg) => {
    expect(installFailure(line)).toBe(pkg);
  });
});

describe("whether a Linux run needs Chromium", () => {
  const FILES: Record<string, string> = {
    "/w/package.json": JSON.stringify({
      scripts: {
        "ci:local": "node scripts/ci-local/run.mjs",
        "test:e2e": "playwright test",
        test: "vitest run",
      },
    }),
    "/w/apps/web/package.json": JSON.stringify({
      devDependencies: { "@vitest/browser-playwright": "5.0.5" },
    }),
    "/w/apps/server/package.json": JSON.stringify({ dependencies: { "playwright-core": "1" } }),
    "/w/apps/broken/package.json": "{",
  };
  const read = (path: string) => FILES[path] ?? null;
  it.each([
    ["npx playwright test --list", "/w", true],
    ["npm run ci:local", "/w", false],
    ["pnpm test:e2e", "/w", true],
    ["npm run test:e2e", "/w", true],
    ["node scripts/x.mjs", "/w", false],
    ["vitest --browser.enabled", "/w", true],
    // The root's tests depend on no browser.
    ["pnpm test", "/w", false],
    ["vp test run src/a.browser.test.tsx", "/w/apps/web", true],
    ["pnpm exec vp test run src/a.browser.test.tsx", "/w/apps/web", true],
    ["vp test run apps/web/src/a.browser.test.tsx", "/w", true],
    ["vp test run src/preview/ServerBrowser.test.ts", "/w/apps/server", true],
    ["vp test run src/a.test.ts", "/w/apps/other", false],
    ["vp test run src/a.test.ts", "/w/apps/broken", false],
    ["vp lint src/a.ts", "/w/apps/web", false],
    ["vp lint playwright.config.ts", "/w", false],
  ] as const)("%s from %s: %s", (line, cwd, needs) => {
    expect(needsBrowser(line.split(" "), cwd, "/w", read)).toBe(needs);
  });
});

describe("remoto markers", () => {
  const fold = (...lines: string[]) =>
    lines.reduce((progress, line) => foldMarker(progress, `${MARKER}${line}`), NO_PROGRESS);

  it.each([
    [
      ["phase=syncing id=app-1a2b3c4d", "phase=running pgid=42", "exit=255"],
      { kind: "finished", code: 255 },
    ],
    [
      ["phase=syncing id=app-1a2b3c4d", "phase=installing", "phase=running pgid=42"],
      { kind: "dropped" },
    ],
    // The pre-flight found the program missing: it exits 127 there without running anything.
    [
      ["phase=syncing id=app-1a2b3c4d", "phase=running pgid=42", "missing=vp", "exit=127"],
      { kind: "missing", tool: "vp" },
    ],
    [["phase=running pgid=42", "missing=", "exit=127"], { kind: "finished", code: 127 }],
    // The wrapper couldn't finish a lazy install: the run ends with the code, the package noted.
    [["phase=running pgid=42", "install=electron", "exit=1"], { kind: "finished", code: 1 }],
    [["phase=syncing id=app-1a2b3c4d"], { kind: "unavailable", touched: true }],
    [[], { kind: "unavailable", touched: false }],
  ] as const)("%j ends as %j", (lines, outcome) => {
    expect(remoteOutcome(fold(...lines))).toEqual(outcome);
  });

  it("notes the package whose install the wrapper couldn't finish", () => {
    expect(fold("phase=running pgid=42", "install=electron", "exit=1").install).toBe("electron");
    expect(fold("phase=running pgid=42", "install=", "exit=1").install).toBeNull();
  });

  it("keeps the run folder and process group, and ignores unsafe ids", () => {
    expect(fold("phase=syncing id=app-1a2b3c4d", "phase=running pgid=42")).toMatchObject({
      id: "app-1a2b3c4d",
      pgid: 42,
      phase: "running",
    });
    expect(fold("phase=syncing id=$(rm -rf ~)").id).toBeNull();
  });

  it("the stop script leaves alone a group that no longer works in the run's folder", () => {
    // A restart reuses process numbers: the recorded group is now someone else's.
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stop-home-"));
    const stranger = NodeChildProcess.spawn("sleep", ["30"], { detached: true, cwd: home });
    try {
      const said = NodeChildProcess.spawnSync(
        "bash",
        ["-c", remoteStopScript("app-1a2b3c4d", stranger.pid!, 1, true)],
        { cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
      expect(said.stdout.trim()).toBe("gone");
      expect(stranger.exitCode).toBeNull();
      expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
    } finally {
      process.kill(stranger.pid!, "SIGKILL");
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("the stop script refuses ids that could escape its quotes", () => {
    expect(() => remoteStopScript("a'; rm -rf ~; '", null, 5)).toThrow(/Unsafe/);
    const script = remoteStopScript("app-1a2b3c4d", 42, 5);
    expect(script).toContain("p=42;");
    expect(script).toContain("[r]uns/app-1a2b3c4d");
    expect(script).toContain("-lt 5 ]");
    // Commands that left the group (setsid, a daemon) still carry the copy's tag.
    expect(script).toContain("grep -qzs '^REMOTO_RUN=app-1a2b3c4d:'");
    expect(script).toContain("kill -KILL $(tagged)");
    expect(remoteStopScript("app.1-2", null, 5)).toContain("'^REMOTO_RUN=app\\.1-2:'");
    // A rerun owns the folder: only the lost run's own group is named, never the folder or pgid file.
    const group = remoteStopScript("app-1a2b3c4d", 42, 5, true);
    expect(group).toContain('kill -TERM -- "-$p"');
    expect(group).not.toMatch(/pkill|pgrep -f|\.pgid|REMOTO_RUN/);
    expect(() => remoteStopScript("app-1a2b3c4d", null, 5, true)).toThrow(/needs one/);
    // `kill -- -1` would reach every process there.
    for (const pgid of [0, 1, -3, 1.5]) {
      expect(() => remoteStopScript("app-1a2b3c4d", pgid, 5)).toThrow(/Unsafe process group/);
    }
    expect(fold("phase=running pgid=1").pgid).toBeNull();
    expect(() => remotePgidScript("a'; rm -rf ~; '")).toThrow(/Unsafe/);
    expect(remotePgidScript("app-1a2b3c4d")).toContain('"runs/app-1a2b3c4d.pgid"');
  });
});

describe("Linux copy of a removed worktree", () => {
  const sha1 = (text: string) => NodeCrypto.createHash("sha1").update(text).digest("hex");

  // Taken from `remoto`'s own naming on macOS: basename | tr -c 'A-Za-z0-9._-\n' _, then shasum.
  it.each([
    ["/Users/x/.t3/worktrees/t3code/t3-d3abb326", "t3-d3abb326-ee096f7e"],
    ["/tmp/my repo/feature é😀", "feature___-c29cc305"],
    ["/a/.hidden", ".hidden-563c52ee"],
  ])("names %s like remoto", (path, id) => {
    expect(runnerCopyId(path, sha1)).toBe(id);
  });

  it("refuses ids that could reach outside the runs folder", () => {
    for (const id of ["", "..", ".hidden-563c52ee", "a/b-563c52ee", "x;rm-563c52ee", "plain"])
      expect(() => removeCopyScript(id)).toThrow(/Unsafe run id/);
  });

  it("removes the copy and its lock files, but not while a run holds it", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-copy-"));
    try {
      const id = "feature-0123abcd";
      const runs = NodePath.join(home, "runs");
      const run = (pgid: number) => {
        NodeFS.mkdirSync(NodePath.join(runs, id, "src"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(runs, `${id}.lock`), "");
        NodeFS.writeFileSync(NodePath.join(runs, `${id}.pgid`), `${pgid}\n`);
        return NodeChildProcess.spawnSync("sh", ["-c", removeCopyScript(id)], {
          env: { ...process.env, HOME: home },
          encoding: "utf8",
        }).stdout.trim();
      };
      const holder = NodeChildProcess.spawn("sleep", ["60"], { detached: true });
      try {
        expect(run(holder.pid!)).toBe("busy");
        expect(NodeFS.existsSync(NodePath.join(runs, id))).toBe(true);
      } finally {
        holder.kill();
      }
      const ended = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid;
      expect(run(ended)).toBe("removed");
      expect(NodeFS.readdirSync(runs)).toEqual([]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Hybrid takes a job from the Mac when the Mac's own verdict holds it", () => {
  /** 4.2 of 16 GiB free with 20% kept: a 1.5 GiB job does not fit, a 0.5 GiB one does. */
  const TIGHT = { ...CALM, availableMemoryBytes: 4.2 * GIB, totalMemoryBytes: 16 * GIB };
  it.each([
    {
      name: "it fits",
      sample: CALM,
      macJobs: 1,
      label: "vp test run",
      queue: true,
      out: "mac-start",
    },
    {
      name: "too much memory",
      sample: TIGHT,
      macJobs: 1,
      label: "vp test run",
      queue: true,
      out: "linux-start",
    },
    {
      name: "too many cores",
      sample: { ...CALM, busyCores: 5 },
      macJobs: 1,
      label: "vp test run",
      queue: true,
      out: "linux-start",
    },
    {
      name: "a smaller job fits",
      sample: TIGHT,
      macJobs: 1,
      label: "vp run lint",
      queue: true,
      out: "mac-start",
    },
    // `plan` always starts a lone job, so an idle Mac has room.
    {
      name: "the Mac is idle",
      sample: TIGHT,
      macJobs: 0,
      label: "vp test run",
      queue: true,
      out: "mac-start",
    },
    // A spike is the sustained limits' call: the instant reading never moves work.
    {
      name: "a CPU spike",
      sample: { ...CALM, busyCores: 9, headroomSince: null },
      macJobs: 1,
      label: "vp test run",
      queue: true,
      out: "mac-wait",
    },
    {
      name: "a stale reading",
      sample: { ...TIGHT, at: NOW - 60_000 },
      macJobs: 1,
      label: "vp test run",
      queue: true,
      out: "mac-wait",
    },
    // With the queue off the Mac never holds a job, so only the sustained limits move work.
    {
      name: "the queue is off",
      sample: TIGHT,
      macJobs: 1,
      label: "vp test run",
      queue: false,
      out: "mac-start",
    },
  ] as const)("$name: $out", ({ sample, macJobs, label, queue, out }) => {
    // Linux runs one of its two: the backlog picks the Mac, and Linux takes what the Mac can't.
    const entries = [
      ...Array.from({ length: macJobs }, (_, i) => runningOn(`m${i}`, "mac")),
      runningOn("l1", "linux"),
      job("a", label),
    ];
    const plan = planRoutes(
      input(entries, { runnerWhere: "automatic" }, { health: READ, sample, enabled: queue }),
    );
    expect(outcomeOf(plan, "a")).toBe(out);
  });

  it("names why the Mac has no room in the waiting reason when Linux is busy too", () => {
    const entries = [
      runningOn("m0", "mac"),
      runningOn("l1", "linux"),
      runningOn("l2", "linux"),
      job("a", "vp test run"),
    ];
    const plan = planRoutes(
      input(entries, { runnerWhere: "automatic" }, { health: READ, sample: TIGHT, runnerOn: true }),
    );
    expect(plan.routes.a).toBe("mac");
    expect(plan.reasons.a).toBe(
      "Hybrid: shorter queue here · memory floor: 1.0 GB room, needs 1.5 GB",
    );
  });
});

describe("quick work never waits for Linux", () => {
  const quick = (id: string, cwd = `/work/${id}`) =>
    job(id, "vp test run a.test.ts b.test.ts", { cwd });
  it.each([
    {
      row: 31,
      name: "another job just started on Linux: no wait for a fresh reading",
      entries: [
        job("l", "vp test run", { startedAt: ago(500), runner: "linux" as const }),
        quick("q"),
      ],
      over: { health: READ },
      config: {},
      runner: "linux",
      why: undefined,
    },
    // Only "unavailable" changes for quick work: a run Linux dropped follows its own policy.
    ...(["agent", "mac"] as const).map((policy) => ({
      row: "25b",
      name: `dropped with the PC gone, If dropped: ${policy}`,
      entries: [
        job("q", "vp test run a.test.ts b.test.ts", {
          cwd: "/work/q",
          dropped: true,
          linkFailures: 3,
          linuxFailedAt: NOW - 500,
        } as never),
      ],
      over: { health: OFFLINE },
      config: { runnerDropped: policy },
      runner: policy === "agent" ? ("cancel" as const) : ("mac" as const),
      why: policy === "agent" ? undefined : "Linux dropped it mid-run: running here",
    })),
  ])("row $row: $name", ({ entries, over, config, runner, why }) => {
    const plan = planRoutes(
      input(entries, { runnerWhere: "linux", ...config }, { ...over, runnerOn: true }),
    );
    if (runner === "cancel") {
      expect(plan.cancels.q).toBeDefined();
      expect(plan.admits.q).toBeUndefined();
      return;
    }
    expect(plan.admits.q).toEqual({ runner, ungated: false });
    expect(plan.asks.q).toBeUndefined();
    expect(plan.reasons.q).toBe(why);
  });

  it("a standard job in the same spots still waits for Linux", () => {
    const entries = [
      runningOn("l", "linux", "/work/w"),
      job("s", "vp test run", { cwd: "/work/w" }),
    ];
    const plan = planRoutes(
      input(entries, { runnerWhere: "linux" }, { health: READ, runnerOn: true }),
    );
    expect(plan.admits.s).toBeUndefined();
    expect(plan.reasons.s).toBe("waiting for Linux: this worktree is already running on Linux");
  });

  it("a service holds no Mac slot and never makes others run alone", () => {
    const entries = [
      job("dev", "vp run dev:desktop", { startedAt: ago(60_000) }),
      job("w", "vp run build"),
    ];
    const plan = planRoutes(input(entries, { runnerWhere: "mac" }, { maxRunning: 1 }));
    expect(plan.admits.w).toEqual({ runner: "mac", ungated: false });
  });
});

describe("Start now keeps a job on the machine it was headed for", () => {
  const forced = (extra: Partial<HeavyQueueEntry> = {}) =>
    job("f", "vp test run", { forced: true, ...extra });
  it.each([
    { name: "Linux slots full", where: "linux", linux: "full", out: "linux-start" },
    { name: "Linux over its limits", where: "linux", linux: "overloaded", out: "linux-start" },
    { name: "no fresh Linux reading yet", where: "linux", linux: "stale", out: "linux-start" },
    // `remoto` serializes one worktree's runs, so starting it would only wait there.
    { name: "same worktree on Linux", where: "linux", linux: "same-worktree", out: "linux-wait" },
    {
      name: "Linux offline, policy Run here",
      where: "linux",
      linux: "offline-mac",
      out: "mac-start",
    },
    {
      name: "Linux offline, policy Wait",
      where: "linux",
      linux: "offline-wait",
      out: "linux-wait",
    },
    { name: "Hybrid, Mac has room", where: "automatic", linux: "full", out: "mac-start" },
    // Linux waits for a fresh reading, and its line is shorter than the full Mac's.
    {
      name: "Hybrid, Mac full, Linux line shorter",
      where: "automatic",
      linux: "stale",
      macFull: true,
      out: "linux-start",
    },
    {
      name: "Hybrid, Mac full, Mac line shorter",
      where: "automatic",
      linux: "full",
      macFull: true,
      out: "mac-start",
    },
    { name: "This Mac, Mac full", where: "mac", linux: "online", macFull: true, out: "mac-start" },
  ] as const)("$name: $out", (row) => {
    const linuxJobs =
      row.linux === "full"
        ? [runningOn("l1", "linux"), runningOn("l2", "linux")]
        : row.linux === "same-worktree"
          ? [runningOn("l1", "linux", "/work/f")]
          : row.linux === "stale"
            ? [{ ...runningOn("l1", "linux"), startedAt: ago(500) }]
            : [];
    const macJobs = "macFull" in row ? ["m1", "m2", "m3"].map((id) => runningOn(id, "mac")) : [];
    const plan = planRoutes(
      input(
        [...macJobs, ...linuxJobs, forced()],
        {
          runnerWhere: row.where,
          runnerUnavailable: row.linux === "offline-wait" ? "wait" : "mac",
        },
        {
          health:
            row.linux === "overloaded"
              ? OVERLOADED
              : row.linux.startsWith("offline")
                ? OFFLINE
                : READ,
        },
      ),
    );
    expect(outcomeOf(plan, "f")).toBe(row.out);
  });

  it("a forced Linux start gives its row no Mac reason", () => {
    const plan = planRoutes(
      input(
        [runningOn("l1", "linux"), runningOn("l2", "linux"), forced()],
        {
          runnerWhere: "linux",
        },
        { health: READ, runnerOn: true },
      ),
    );
    expect(plan.admits.f).toEqual({ runner: "linux", ungated: false });
    expect(plan.reasons.f).toBeUndefined();
  });
});

describe("Linux limits as a waiting reason", () => {
  it.each([
    {
      name: "over its limits",
      health: OVERLOADED,
      linuxJobs: 0,
      sameWorktree: false,
      over: "1.8 GB free, keeping 20%",
    },
    {
      name: "easing back under",
      health: { ...READ, overLimit: true },
      linuxJobs: 0,
      sameWorktree: false,
      over: "easing back under its limits",
    },
    // Full slots come first: the limits are not what holds it.
    {
      name: "slots full and over",
      health: OVERLOADED,
      linuxJobs: 2,
      sameWorktree: false,
      over: undefined,
    },
    {
      name: "same worktree",
      health: OVERLOADED,
      linuxJobs: 1,
      sameWorktree: true,
      over: undefined,
    },
    // `nextHealth` keeps `overLimit` through failed checks: offline is never "over its limits".
    {
      name: "offline",
      health: { ...OVERLOADED, online: false },
      linuxJobs: 0,
      sameWorktree: false,
      over: undefined,
    },
    {
      name: "not checked yet",
      health: { ...UNKNOWN_HEALTH, overLimit: true },
      linuxJobs: 0,
      sameWorktree: false,
      over: undefined,
    },
    { name: "has room", health: READ, linuxJobs: 0, sameWorktree: false, over: undefined },
  ])("$name", ({ health, linuxJobs, sameWorktree, over }) => {
    const entries = [
      ...Array.from({ length: linuxJobs }, (_, i) =>
        runningOn(`l${i}`, "linux", sameWorktree ? "/work/a" : `/work/l${i}`),
      ),
      job("a", "vp test run"),
    ];
    for (const where of ["linux", "automatic"] as const) {
      const plan = planRoutes(
        input(
          entries,
          { runnerWhere: where, runnerUnavailable: "wait" },
          {
            health,
            maxRunning: 1,
            ...(where === "automatic" ? { entries: [runningOn("m0", "mac"), ...entries] } : {}),
          },
        ),
      );
      // Hybrid sends it to the Mac, which is under its own limits, instead of holding it.
      expect(plan.linuxOver.a).toBe(where === "linux" ? over : undefined);
    }
  });
});

describe("the order admission tries waiters in", () => {
  const history = {
    [signatureOf("vp run build")]: [{ cpu: 2, memoryBytes: GIB, durationMs: 240_000 }],
    [signatureOf("vp test run")]: [{ cpu: 2, memoryBytes: GIB, durationMs: 120_000 }],
  };

  it("Linux's one free slot takes the shortest eligible waiter, not the first in the file", () => {
    const plan = planRoutes(
      input(
        [job("build", "vp run build"), job("test", "vp test run")],
        { runnerWhere: "linux" },
        { history, machine: { ...DEFAULT_MACHINE_CONFIG, runnerLinuxSlots: 1 } },
      ),
    );
    expect(outcomeOf(plan, "test")).toBe("linux-start");
    expect(outcomeOf(plan, "build")).toBe("linux-wait");
    expect(plan.ordered).toEqual(["test", "build"]);
    expect(plan.order.build).toEqual({ code: "shorter", text: "shorter runs go first" });
  });

  it.each([
    {
      name: "no rule: the shorter test first",
      build: "normal",
      test: "normal",
      expected: ["test", "build"],
      buildCode: "shorter",
    },
    {
      name: "the user's own build leads a shorter agent test",
      build: "first",
      test: "normal",
      expected: ["build", "test"],
      buildCode: "first",
    },
    {
      name: "a last test trails a longer build",
      build: "normal",
      test: "last",
      expected: ["build", "test"],
      buildCode: "shorter",
    },
  ] as const)("$name", ({ build, test, expected, buildCode }) => {
    const entries = [job("test", "vp test run"), job("build", "vp run build")];
    const lane = (entry: HeavyQueueEntry) => (entry.id === "build" ? build : test);
    const plan = planRoutes(input(entries, {}, { history, lane }));
    expect(plan.ordered).toEqual(expected);
    expect(plan.order.build?.code).toBe(buildCode);
  });
});
