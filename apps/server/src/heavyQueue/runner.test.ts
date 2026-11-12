// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry, RunnerProjectConfig } from "@t3tools/contracts";

import {
  DEFAULT_MACHINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  eligibilityOf,
  foldMarker,
  matchesAny,
  mayPublish,
  nextHealth,
  NO_PROGRESS,
  parseHeartbeat,
  planRoutes,
  platformFailures,
  remoteOutcome,
  remoteStopScript,
  runnerConfigFor,
  sshArgs,
  UNKNOWN_HEALTH,
  MARKER,
  type LinuxHealth,
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
  now: NOW,
  contextOf: (cwd) => ({
    config: { ...DEFAULT_PROJECT_CONFIG, runnerEnabled: true, ...config },
    worktree: cwd,
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
  const queues = ["on", "off", "paused"] as const;
  const runners = [true, false] as const;
  const wheres = ["mac", "linux", "automatic"] as const;
  const linuxStates = ["online", "offline", "full", "same-worktree", "unknown"] as const;
  const macLoads = ["below", "at"] as const;
  const kinds = {
    eligible: "vp test run",
    exclusive: "xcrun simctl boot iPhone",
    "mac-only": "vp test run --project ios -- xcodebuild",
    "not-listed": "vp run build",
  } as const;

  /** The spec's routing rules, written out case by case. */
  const expected = (
    queue: (typeof queues)[number],
    runner: boolean,
    where: (typeof wheres)[number],
    linux: (typeof linuxStates)[number],
    load: (typeof macLoads)[number],
    kind: keyof typeof kinds,
  ): Outcome => {
    // Mac admission: queue off starts at once; paused holds; three running fill the slots; an
    // exclusive job waits for the running ones to finish.
    const mac: Outcome =
      queue === "off"
        ? "mac-start"
        : queue === "paused" || load === "at" || kind === "exclusive"
          ? "mac-wait"
          : "mac-start";
    if (!runner || kind !== "eligible" || where === "mac") return mac;
    const linuxFree = linux === "online";
    if (where === "linux") {
      if (queue === "paused") return "linux-wait";
      if (linux === "offline") return "ask";
      return linuxFree ? "linux-start" : "linux-wait";
    }
    // Automatic: under N on the Mac stays there; at N goes to Linux when it can.
    if (load === "below" || queue === "paused" || !linuxFree) return mac;
    return "linux-start";
  };

  const cases = queues.flatMap((queue) =>
    runners.flatMap((runner) =>
      wheres.flatMap((where) =>
        linuxStates.flatMap((linux) =>
          macLoads.flatMap((load) =>
            (Object.keys(kinds) as Array<keyof typeof kinds>).map(
              (kind) => [queue, runner, where, linux, load, kind] as const,
            ),
          ),
        ),
      ),
    ),
  );

  it.each(cases)(
    "queue %s, runner %s, %s, Linux %s, Mac queue %s N, %s job",
    (queue, runner, where, linux, load, kind) => {
      const macRunning = load === "at" ? 3 : 1;
      const entries = [
        ...Array.from({ length: macRunning }, (_, i) => runningOn(`mac${i}`, "mac")),
        ...(linux === "full"
          ? [runningOn("l1", "linux"), runningOn("l2", "linux")]
          : linux === "same-worktree"
            ? [runningOn("l1", "linux", "/work/w")]
            : []),
        job("w", kinds[kind]),
      ];
      const plan = planRoutes(
        input(
          entries,
          { runnerEnabled: runner, runnerWhere: where, runnerOverflow: 3 },
          {
            enabled: queue !== "off",
            paused: queue === "paused",
            health: linux === "offline" ? OFFLINE : linux === "unknown" ? UNKNOWN_HEALTH : ONLINE,
          },
        ),
      );
      expect(outcomeOf(plan, "w")).toBe(expected(queue, runner, where, linux, load, kind));
    },
  );

  it("Automatic with N=3 and five agents: the 4th and 5th go to Linux", () => {
    const entries = ["a", "b", "c", "d", "e"].map((id) => job(id, "vp test run"));
    const plan = planRoutes(input(entries, { runnerWhere: "automatic", runnerOverflow: 3 }));
    expect(plan.routes).toEqual({ a: "mac", b: "mac", c: "mac", d: "linux", e: "linux" });
    expect(plan.admits).toEqual({
      a: { runner: "mac", ungated: false },
      d: { runner: "linux", ungated: false },
      e: { runner: "linux", ungated: false },
    });
  });

  it("Linux slots are a setting, and a full Linux keeps Automatic work on the Mac", () => {
    const entries = ["a", "b", "c", "d", "e"].map((id) => job(id, "vp test run"));
    const plan = planRoutes(
      input(
        entries,
        { runnerWhere: "automatic", runnerOverflow: 3 },
        { machine: { ...DEFAULT_MACHINE_CONFIG, runnerLinuxSlots: 1 } },
      ),
    );
    expect(plan.routes).toMatchObject({ d: "linux", e: "mac" });
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

  it("a forced (Start now) job starts on the Mac whatever the Runner says", () => {
    const plan = planRoutes(
      input([job("a", "vp test run", { forced: true })], { runnerWhere: "linux" }),
    );
    expect(plan.admits).toEqual({ a: { runner: "mac", ungated: false } });
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

  it("a remoto failure counts Linux down for that job until a newer heartbeat succeeds", () => {
    const failed = job("a", "vp test run", { linuxFailedAt: NOW - 500 });
    const stale = planRoutes(
      input(
        [failed],
        { runnerWhere: "linux", runnerUnavailable: "mac" },
        {
          health: { ...ONLINE, okAt: NOW - 1000 },
        },
      ),
    );
    expect(stale.admits.a?.runner).toBe("mac");
    const fresh = planRoutes(
      input(
        [failed],
        { runnerWhere: "linux", runnerUnavailable: "mac" },
        {
          health: { ...ONLINE, okAt: NOW - 100 },
        },
      ),
    );
    expect(fresh.admits.a?.runner).toBe("linux");
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
  ] as const)("dropped mid-run: %s → %s, apart from the unavailable policy", (policy, outcome) => {
    const plan = offline(job("a", "vp test run", { dropped: true }), {
      runnerDropped: policy,
      runnerUnavailable: "wait",
    });
    expect(outcomeOf(plan, "a")).toBe(outcome);
    if (outcome === "ask") expect(plan.asks.a).toBe("dropped");
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

  it("paused holds both runners; a forced job still starts", () => {
    const plan = planRoutes(
      input(
        [job("l", "vp test run"), job("f", "vp test run", { forced: true })],
        { runnerWhere: "linux" },
        { paused: true },
      ),
    );
    expect(plan.admits).toEqual({ f: { runner: "mac", ungated: false } });
    expect(plan.reasons.l).toBe("paused");
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
  ])("%s matches %s: %s", (text, pattern, result) => {
    expect(matchesAny(text, [pattern])).toBe(result);
  });

  it.each([
    ["vp test run", "linux"],
    ["vp run typecheck && vp run lint", "linux"],
    ["vp run build && vp test run", "not-listed"],
    ["xcodebuild -scheme App test", "mac-only"],
    ["vp run dev:desktop", "exclusive"],
    ["echo hi", "not-listed"],
  ])("%s is %s by default", (label, eligibility) => {
    expect(eligibilityOf({ label }, DEFAULT_PROJECT_CONFIG)).toBe(eligibility);
  });

  it("device opens held by a server are exclusive", () => {
    expect(eligibilityOf({ label: "Open iPhone", server: true }, DEFAULT_PROJECT_CONFIG)).toBe(
      "exclusive",
    );
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
  const config = (overflow: number) => ({ ...DEFAULT_PROJECT_CONFIG, runnerOverflow: overflow });
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
  ] as const)("%s uses overflow from the deepest project", (cwd, aliases, overflow) => {
    expect(runnerConfigFor(block, cwd, aliases).runnerOverflow).toBe(overflow);
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
    let health = nextHealth(UNKNOWN_HEALTH, fail, 3, 1);
    expect(health).toMatchObject({ online: null, failures: 1 });
    health = nextHealth(health, fail, 3, 2);
    expect(health.online).toBeNull();
    health = nextHealth(health, fail, 3, 3);
    expect(health).toMatchObject({ online: false, failures: 3, error: "timeout" });
    health = nextHealth(health, ok, 3, 4);
    expect(health).toMatchObject({ online: true, failures: 0, okAt: 4, load1: 0.5, cpuCount: 6 });
    expect(nextHealth(health, fail, 3, 5)).toMatchObject({ online: true, failures: 1 });
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
    [["phase=syncing id=app-1a2b3c4d"], { kind: "unavailable", touched: true }],
    [[], { kind: "unavailable", touched: false }],
  ] as const)("%j ends as %j", (lines, outcome) => {
    expect(remoteOutcome(fold(...lines))).toEqual(outcome);
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
