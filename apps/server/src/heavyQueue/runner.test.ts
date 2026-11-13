// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry, RunnerProjectConfig } from "@t3tools/contracts";

import {
  DEFAULT_MACHINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  eligibilityOf,
  foldMarker,
  installFailure,
  linkMachine,
  matchesAny,
  mayPublish,
  nextHealth,
  NEEDS_GIT,
  NO_PROGRESS,
  parseHeartbeat,
  planRoutes,
  platformFailures,
  remoteOutcome,
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
/** A heartbeat with numbers: 8 of 12 GiB free, load 0.5 on 6 cores. */
const READ: LinuxHealth = {
  ...ONLINE,
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
  macMemoryFloorPercent: 20,
  macCpuCeilingPercent: 70,
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
  // "spike": the latest reading is over the limits, but not for the whole window.
  const macStates = ["room", "full", "over", "spike"] as const;
  const kinds = {
    eligible: "vp test run",
    exclusive: "xcrun simctl boot iPhone",
    "mac-only": "vp test run --project ios -- xcodebuild",
    "not-listed": "vp run build",
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
    // Mac first, sending to Linux from 2 jobs: 1 runs here except when the Mac is full.
    if (where === "macFirst") {
      if (mac !== "over" && mac !== "full") return onMac;
      return queue === "paused" ? "linux-wait" : linuxStart;
    }
    // Hybrid: the smaller backlog per slot (3 here, 2 there), the Mac on a tie.
    const macLine = (mac === "full" ? 3 : 1) / 3;
    const linuxLine = (linuxRunningIn[linux] ?? 0) / 2;
    let here = macLine <= linuxLine;
    if (here && mac === "over") here = false;
    else if (!here && linux === "overloaded") here = true;
    // A machine that can start it now takes it from one that can't.
    const macRoom = off ? mac !== "over" : mac === "room" || mac === "spike";
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
      const over = mac === "over" || mac === "spike";
      const plan = planRoutes(
        input(
          entries,
          { runnerEnabled: runner, runnerWhere: where, runnerMacFirstAfter: 2 },
          {
            enabled: queue === "on" || queue === "paused",
            paused: queue === "paused" || queue === "off-paused",
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
      "waiting for Linux: a fresh reading since the last job started there",
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
          health: { ...READ, load1: 5.4, overLimit: true },
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

  it("the next Linux start waits for a heartbeat taken after the last one started", () => {
    const entries = [
      { ...runningOn("l1", "linux"), startedAt: ago(5_000) },
      job("a", "vp test run"),
    ];
    const at = (okAt: number, health: LinuxHealth = READ) =>
      planRoutes(input(entries, { runnerWhere: "linux" }, { health: { ...health, okAt } })).admits
        .a;
    expect(at(NOW - 6_000)).toBeUndefined();
    expect(at(NOW - 5_000)).toBeUndefined();
    expect(at(NOW - 4_000)).toEqual({ runner: "linux", ungated: false });
    // Without numbers in the heartbeat, only the slots count.
    expect(at(NOW - 6_000, ONLINE)).toEqual({ runner: "linux", ungated: false });
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
    const plan = planRoutes(input([job("a", "make deploy", { where: "linux" })]));
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

  // RUN-01: Everything sends unlisted work too, never what has to stay on this Mac.
  it.each(
    QUEUE.flatMap((enabled) =>
      [false, true].flatMap((everything) =>
        (
          [
            ["vp run build", everything ? "linux" : "mac"],
            ["vp test run", "linux"],
            ["pnpm install", "mac"],
            ["xcodebuild test", "mac"],
            ["vp run dev", "mac"],
            ["vp run mobile:install ios", "mac"],
          ] as const
        ).map(([line, route]) => [line, everything, enabled, route] as const),
      ),
    ),
  )(
    "Linux, %s with Everything %s (queue on: %s) runs on %s",
    (line, everything, enabled, route) => {
      const plan = planned(
        [job("a", line)],
        { runnerWhere: "linux", runnerLinuxEverything: everything },
        { enabled },
      );
      expect(plan.routes.a).toBe(route);
    },
  );

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

  /** Minutes until the last job ends, replanning whenever a job ends, with fresh readings. */
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
      t = Math.min(...running.map((entry) => ends.get(entry.id)!));
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
    expect(spans).toEqual({ mac: 19, linux: 20, hybrid: 12 });
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
        { health: { ...ONLINE, okAt: NOW - 60_000 } },
      ),
    ).toBe(outcome);
  });

  it.each([
    ["unavailable, Run on this Mac", { linkFailures: 3 }, { runnerUnavailable: "mac" }, ONLINE],
    ["Linux offline, Run on this Mac", {}, { runnerUnavailable: "mac" }, OFFLINE],
    [
      "dropped, Run on this Mac",
      { dropped: true, linkFailures: 3 },
      { runnerDropped: "mac" },
      ONLINE,
    ],
    [
      "a question nobody answered",
      { linkFailures: 3, ask: { reason: "unavailable" as const, deadlineAt: ago(1) } },
      { runnerUnavailable: "ask", runnerDeadlineAction: "mac" },
      ONLINE,
    ],
    ["Hybrid with Linux offline", {}, { runnerWhere: "automatic" }, OFFLINE],
  ] as const)("%s: a strained Mac keeps the job for Linux", (_, failed, config, health) => {
    const entry = { linuxFailedAt: NOW - 500, ...failed };
    const over = { health: { ...health, okAt: NOW - 60_000 } };
    expect(plannedWith(entry, config, { ...over, ...STRAINED })).toBe("linux-wait");
    // A reading older than a heartbeat no longer speaks for this Mac.
    const stale = { sample: { ...STRAINED.sample, at: NOW - 21_000 } };
    expect(plannedWith(entry, config, { ...over, ...stale })).toMatch(/^mac-/);
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

  it.each([
    ["mac", "mac-start"],
    ["wait", "linux-wait"],
    ["ask", "ask"],
    ["agent", "cancel"],
  ] as const)("dropped mid-run: %s → %s, apart from the unavailable policy", (policy, outcome) => {
    const plan = offline(job("a", "vp test run", { dropped: true }), {
      runnerDropped: policy,
      runnerUnavailable: "wait",
    });
    expect(plan.cancels.a !== undefined ? "cancel" : outcomeOf(plan, "a")).toBe(outcome);
    if (outcome === "ask") expect(plan.asks.a).toBe("dropped");
  });

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

  it("an unconfirmed drop reruns nowhere until Linux confirms it stopped", () => {
    const plan = planRoutes(input([job("a", "vp test run", { unconfirmed: true })]));
    expect(plan.admits).toEqual({});
    expect(plan.reasons.a).toMatch(/confirming it stopped/);
  });

  it("before the first heartbeat a Linux job waits instead of asking", () => {
    const plan = planRoutes(
      input([job("a", "vp test run")], { runnerWhere: "linux" }, { health: UNKNOWN_HEALTH }),
    );
    expect(plan.asks).toEqual({});
    expect(plan.reasons.a).toBe("checking whether Linux is up");
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

  it("Runner off sends Linux waiters down the Mac path", () => {
    const off = planRoutes(input(entries, { runnerEnabled: false }, { health: OFFLINE }));
    expect(off.routes.linuxWaiter).toBe("mac");
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
      job("run", "git commit -m x", { startedAt: ago(1000) }),
      job("commit", "git commit -m 'fix: t3 heavy'"),
      job("build", "vp run build"),
      job("moved", "vp test run", { route: "mac" }),
      job("back", "vp test run", {
        route: "mac",
        routeReason: "Uses a file outside the project: /x",
      } as Partial<HeavyQueueEntry>),
      job("forced", "vp test run", { forced: true }),
    ];
    const at = (over: Partial<RoutePlanInput>, config: Partial<RunnerProjectConfig> = {}) =>
      planRoutes(input(entries, { runnerWhere: "linux", ...config }, { maxRunning: 1, ...over }))
        .reasons;
    const commits = "Commits run here: the pre-commit edits this Mac's repository";
    expect(at({ runnerOn: true })).toEqual({
      run: commits,
      commit: `${commits} · the one slot is busy`,
      build: "Not on the Can run on Linux list: vp run build · waiting its turn",
      moved: "Moved to this Mac · waiting its turn",
      back: "Uses a file outside the project: /x · waiting its turn",
    });
    expect(at({ runnerOn: true }, { runnerWhere: "mac" }).build).toMatch(/^Not on the/);
    expect(at({ runnerOn: true, enabled: false }, { runnerEnabled: false })).toMatchObject({
      build: "Runner off for this project",
    });
    // With every Runner off, rows read as they always did, but a commit still says why it waits.
    const hook = "Commit hook runs checks";
    expect(at({}, { runnerEnabled: false })).toEqual({
      run: hook,
      commit: `${hook} · next in line`,
      build: "waiting its turn",
      moved: "waiting its turn",
      back: "waiting its turn",
    });
    expect(at({ runnerOn: true, enabled: false }, { runnerEnabled: false }).commit).toBe(hook);
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
  ])("%s matches %s: %s", (text, pattern, result) => {
    expect(matchesAny(text, [pattern])).toBe(result);
  });

  const at = { config: DEFAULT_PROJECT_CONFIG, home: "/home/me", rootOf: () => "/w" };
  it.each([
    ["vp test run", "linux", null],
    ["vp run typecheck && vp run lint", "linux", null],
    ["vp run build && vp test run", "not-listed", "Not on the Can run on Linux list: vp run build"],
    ["xcodebuild -scheme App test", "mac-only", "Always on this Mac: xcodebuild"],
    ["vp run dev:desktop", "exclusive", "Always on this Mac: vp run dev:desktop"],
    ["echo hi", "mac-only", "Nothing in it runs on Linux"],
    ["./scripts/ci.sh", "not-listed", "Not on the Can run on Linux list: ci.sh"],
    // The Linux copy has no `.git`: what diffs against it stays here, except check:changed,
    // whose changed files this Mac computes and hands over.
    ["vp run check:changed", "linux", null],
    ["timeout 3500 vp run check:changed origin/main", "linux", null],
    ["vp test run --changed", "mac-only", NEEDS_GIT],
    ["npx jest --onlyChanged", "mac-only", NEEDS_GIT],
    ["vp test run --changedSince=origin/main", "mac-only", NEEDS_GIT],
    ["remoto vp staged", "mac-only", NEEDS_GIT],
    ["remoto /usr/bin/git status", "mac-only", NEEDS_GIT],
    ["vp test run src/changed.test.ts src/staged/a.test.ts", "linux", null],
    ["vp test run unchanged", "linux", null],
    ['vp test run src/a.test.ts -t "the title changed"', "linux", null],
    ["vp test run -t staged", "linux", null],
    ["vp test run --reporter=changed", "linux", null],
    ["pnpm --filter web check:changed", "linux", null],
  ])("%s is %s by default", (label, eligibility, reason) => {
    expect(eligibilityOf({ label, cwd: "/w" }, at)).toEqual({ eligibility, reason });
  });

  // Every mode, even with nothing on Always on this Mac and everything allowed on Linux.
  const open = {
    ...at,
    config: { ...DEFAULT_PROJECT_CONFIG, runnerMacOnly: [], runnerLinuxCommands: ["*"] },
  };
  it.each([
    ["pnpm install", "pnpm install"],
    ["vp i", "vp i"],
    ["npm ci", "npm ci"],
    ["yarn add react", "yarn add react"],
    ["pnpm --filter web remove lodash", "pnpm web remove"],
    ["xcodebuild -scheme App test", "xcodebuild App test"],
    ["adb install app.apk", "adb install app.apk"],
    ["pnpm exec next start", "pnpm exec next"],
    ["vp run dev", "vp run dev"],
    ["pnpm start", "pnpm start"],
    ["npm run watch:css", "npm run watch:css"],
    ["npx vite", "npx vite"],
    ["npx next dev", "npx next dev"],
  ])("%s stays on this Mac whatever the lists say", (label, name) => {
    expect(eligibilityOf({ label, cwd: "/w" }, open)).toEqual({
      eligibility: "mac-only",
      reason: `Always on this Mac: ${name}`,
    });
  });
  it.each(["vp test run", "npx vite build", "pnpm run build", "./scripts/ci.sh"])(
    "%s may still leave",
    (label) => {
      expect(eligibilityOf({ label, cwd: "/w" }, open).eligibility).toBe("linux");
    },
  );

  // The queue read each script when the job was queued; the Runner judges its text.
  it.each([
    ["vp test run", "linux", null],
    ["cd sub && vp run lint", "linux", null],
    ["vp run build", "not-listed", "Not on the Can run on Linux list: vp run build"],
    [
      "git add . && git commit -m x",
      "mac-only",
      "Commits run here: the pre-commit edits this Mac's repository",
    ],
    ["vp test run /etc/hosts", "mac-only", "Uses a file outside the project: /etc/hosts"],
    [null, "mac-only", "Couldn't read this script"],
  ] as const)("a script outside the project running %j is %s", (body, eligibility, reason) => {
    for (const label of ["bash /tmp/s/v.sh", "/tmp/s/v.sh --fast"]) {
      const scripts = { "/tmp/s/v.sh": body };
      expect(eligibilityOf({ label, cwd: "/w", scripts }, at)).toEqual({ eligibility, reason });
    }
  });

  it("a job the hook queued on this Mac shows why", () => {
    const entry = {
      ...job("s", "bash missing.sh"),
      where: "mac" as const,
      routeReason: "Couldn't read this script",
    };
    const plan = planRoutes(input([entry], {}, { runnerOn: true }));
    expect(plan.reasons.s).toContain("Couldn't read this script");
  });

  it("judges the full line a long label was cut from, and device opens held by a server", () => {
    const line = `vp test run ${"a".repeat(200)} /etc/hosts`;
    expect(eligibilityOf({ label: line.slice(0, 200), line, cwd: "/w" }, at)).toEqual({
      eligibility: "mac-only",
      reason: "Uses a file outside the project: /etc/hosts",
    });
    expect(eligibilityOf({ label: "Open iPhone", server: true, cwd: "/w" }, at)).toEqual({
      eligibility: "exclusive",
      reason: "Always on this Mac: Open iPhone",
    });
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
      load1: 0.5,
      cpuCount: 6,
    });
    expect(nextHealth(health, fail, machine, 20_000, beat(5))).toMatchObject({
      online: true,
      failures: 1,
    });
  });

  describe("over its limits only on sustained readings", () => {
    const WINDOW = 20_000;
    const BEAT = DEFAULT_MACHINE_CONFIG.runnerHeartbeatSeconds * 1000;
    const reading = (freeGib: number, load1 = 0.5) => ({
      ok: true as const,
      reading: {
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
    const busy = reading(8, 5.4);

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

  it("reads load, cores and memory from the heartbeat output", () => {
    const text = [
      "1.25 0.80 0.50 2/400 1234",
      "6",
      "               total        used        free      shared  buff/cache   available",
      "Mem:     12000000000  3000000000  6000000000     1000000  3000000000  8500000000",
      "Swap:     4000000000           0  4000000000",
    ].join("\n");
    expect(parseHeartbeat(text)).toEqual({
      load1: 1.25,
      cpuCount: 6,
      totalMemoryBytes: 12_000_000_000,
      availableMemoryBytes: 8_500_000_000,
    });
    expect(parseHeartbeat("garbage")).toEqual({
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
  ] as const)("%j is an install failure of %j", (line, pkg) => {
    expect(installFailure(line)).toBe(pkg);
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

  it("the stop script refuses ids that could escape its quotes", () => {
    expect(() => remoteStopScript("a'; rm -rf ~; '", null, 5)).toThrow(/Unsafe/);
    const script = remoteStopScript("app-1a2b3c4d", 42, 5);
    expect(script).toContain("p=42;");
    expect(script).toContain("[r]uns/app-1a2b3c4d");
    expect(script).toContain("-lt 5 ]");
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
  /** 6 of 16 GiB free with 20% kept: a 4 GiB job does not fit, a 1.5 GiB one does. */
  const TIGHT = { ...CALM, availableMemoryBytes: 6 * GIB, totalMemoryBytes: 16 * GIB };
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
      "Hybrid: shorter queue here · needs ~4.0 GB; 6.0 GB free, 3.2 GB kept spare",
    );
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
