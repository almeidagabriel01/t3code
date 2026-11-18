// @effect-diagnostics globalDate:off nodeBuiltinImport:off
// The 17/11 incident on a 6-core, 12 GB WSL PC: the OOM killer took a container's mysqld while
// PSI memory full sat at 57%, load1 read 206 over an idle CPU, and T3 showed "Offline" and then an
// unexplained "over its limits". These cases hold its numbers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { HEAVY_QUEUE_DEFAULTS, linuxOverText, type HeavyQueueEntry } from "@t3tools/contracts";

import {
  DEFAULT_MACHINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  linuxOverBy,
  linuxStatus,
  linuxStops,
  nextHealth,
  parseHeartbeat,
  planRoutes,
  idleCopiesScript,
  removeCopyScript,
  unresponsiveFailure,
  UNKNOWN_HEALTH,
  type LinuxHealth,
  type LinuxOutside,
  type LinuxReading,
  type RoutePlanInput,
} from "./runner.ts";

const GIB = 1024 ** 3;
const NOW = Date.parse("2026-11-17T22:18:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const machine = DEFAULT_MACHINE_CONFIG;

const job = (id: string, label: string, extra: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label,
  cwd: `/work/${id}`,
  createdAt: ago(1000),
  startedAt: null,
  ...extra,
});
const onLinux = (id: string, label: string, memory?: number) =>
  job(id, label, {
    startedAt: ago(600_000),
    runner: "linux",
    phase: "running",
    remote: { id: `${id}-0123abcd` },
    ...(memory === undefined ? {} : { memory, peakMemory: memory }),
  });

/** The PC at rest: 6 cores, 12 GB, nothing stalled. */
const QUIET: LinuxReading = {
  cpuPercent: 4,
  load1: 0.4,
  cpuCount: 6,
  availableMemoryBytes: 10 * GIB,
  totalMemoryBytes: 12 * GIB,
  swapTotalBytes: 4 * GIB,
  swapFreeBytes: 4 * GIB,
  pressure: { cpu: 1, memorySome: 0, memoryFull: 0, ioFull: 0 },
};
const health = (reading: Partial<LinuxReading> = {}, extra: Partial<LinuxHealth> = {}) =>
  ({
    ...UNKNOWN_HEALTH,
    online: true,
    okAt: NOW - 1000,
    ...QUIET,
    ...reading,
    ...extra,
  }) as LinuxHealth;

const input = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  where: "linux" | "automatic",
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
    config: { ...DEFAULT_PROJECT_CONFIG, runnerEnabled: true, runnerWhere: where },
    worktree: cwd,
    home: "/home/me",
    rootOf: () => "/work",
  }),
  machine: { ...machine, runnerLinuxSlots: 5 },
  health: health(),
  ...over,
});

describe("the heartbeat reads memory, swap, pressure and each run's memory", () => {
  const STAT = "cpu  2255340 3412 2290112 22625563 6290 0 4562 0 0 0";
  const IDLE = "cpu  2255344 3412 2290114 22625857 6290 0 4562 0 0 0";
  const text = (psi: boolean) =>
    [
      "206.12 180.00 120.00 9/900 4321",
      "6",
      STAT,
      IDLE,
      "21231.50 90000.00",
      "MemTotal:       12251236 kB",
      "MemAvailable:     512000 kB",
      "SwapTotal:       4194304 kB",
      "SwapFree:          65536 kB",
      ...(psi
        ? [
            "psi cpu some avg10=2.10 avg60=1.00 avg300=0.50 total=1",
            "psi cpu full avg10=0.00 avg60=0.00 avg300=0.00 total=0",
            "psi memory some avg10=60.00 avg60=58.00 avg300=60.00 total=2",
            "psi memory full avg10=57.00 avg60=55.00 avg300=57.00 total=3",
            "psi io some avg10=70.00 avg60=60.00 avg300=50.00 total=4",
            "psi io full avg10=40.00 avg60=30.00 avg300=20.00 total=5",
          ]
        : []),
      "job t3-a-0123abcd 4242 2097152",
      "job t3-b-89abcdef 4300 0",
      "job t3-c-01234567 2097152",
    ].join("\n");

  it("reads the incident's numbers", () => {
    const reading = parseHeartbeat(text(true));
    expect(reading).toMatchObject({
      load1: 206.12,
      cpuCount: 6,
      totalMemoryBytes: 12251236 * 1024,
      availableMemoryBytes: 512000 * 1024,
      swapTotalBytes: 4194304 * 1024,
      swapFreeBytes: 65536 * 1024,
      uptimeSeconds: 21231.5,
      pressure: { cpu: 2.1, memorySome: 60, memoryFull: 57, ioFull: 40 },
      jobMemory: {
        "t3-a-0123abcd": { pgid: 4242, bytes: 2 * GIB },
        "t3-b-89abcdef": { pgid: 4300, bytes: 0 },
      },
    });
    expect(Math.round(reading.cpuPercent!)).toBe(2);
  });

  it("lists heavy work outside the queue by cgroup, one bad line hiding nothing", () => {
    const DOCKER = "a".repeat(64);
    const SESSION = "/user.slice/user-1001.slice/session-7.scope";
    const lines = [
      "206.12 180.00 120.00 9/900 4321",
      "6",
      // 600 ticks over 6 cores: 100 ticks per core in the window.
      "cpu  1000 0 0 0 0 0 0 0 0 0",
      "cpu  1300 0 0 300 0 0 0 0 0 0",
      "self 0::/user.slice/user-1001.slice/session-9.scope",
      "job t3-a-0123abcd 4242 2097152 /user.slice/user-1001.slice/session-3.scope",
      // A container: 580 ticks is 5.8 cores, 8 GiB.
      `out 580 ${8 * GIB} 900 /system.slice/docker-${DOCKER}.scope`,
      `outcmd 900 yes`,
      `dock\t${DOCKER}\terp-ci-3\tnode:22\tthread-1\t`,
      // A direct remoto run in its copy, not the queue's.
      `out 120 ${2 * GIB} 950 ${SESSION}`,
      "outcmd 950 node --test",
      "outcwd 950 /home/dev/runs/erp-feat-89abcdef/apps/api",
      // The queue's own job, by its session and by its copy, and the heartbeat itself.
      `out 300 ${GIB} 960 /user.slice/user-1001.slice/session-3.scope`,
      `out 300 ${GIB} 961 /user.slice/user-1001.slice/session-4.scope`,
      "outcwd 961 /home/dev/runs/t3-a-0123abcd",
      `out 300 ${GIB} 962 /user.slice/user-1001.slice/session-9.scope`,
      // Light: under half a core and 1 GiB.
      "out 20 1000 970 /system.slice/cron.service",
      // Garbage never hides the rest.
      "out x y z",
      "out 50",
      "outcmd notapid ls",
    ].join("\n");
    expect(parseHeartbeat(lines).outside).toEqual([
      {
        cgroup: `/system.slice/docker-${DOCKER}.scope`,
        pid: 900,
        cpu: 5.8,
        memoryBytes: 8 * GIB,
        command: "yes",
        container: { id: DOCKER.slice(0, 12), name: "erp-ci-3", image: "node:22" },
        threadId: "thread-1",
      },
      {
        cgroup: SESSION,
        pid: 950,
        cpu: 1.2,
        memoryBytes: 2 * GIB,
        command: "node --test",
        runId: "erp-feat-89abcdef",
      },
    ]);
  });

  it("lists nothing outside the queue from a heartbeat without those lines", () => {
    expect(parseHeartbeat(text(true)).outside).toEqual([]);
  });

  it("reads no pressure where the kernel has no PSI", () => {
    expect(parseHeartbeat(text(false)).pressure).toBeNull();
  });

  it("reads nothing from garbage", () => {
    expect(parseHeartbeat("garbage")).toMatchObject({
      load1: null,
      availableMemoryBytes: null,
      totalMemoryBytes: null,
      swapTotalBytes: null,
      swapFreeBytes: null,
      pressure: null,
      jobMemory: {},
    });
  });
});

describe("Linux's ceiling reads pressure and free memory, never the load", () => {
  it.each<[string, Partial<LinuxReading>, ReadonlyArray<string>, RegExp | null]>([
    ["load 206 over an idle CPU", { load1: 206, cpuPercent: 3 }, [], null],
    [
      "load 206 while memory is stalled 57%",
      { load1: 206, cpuPercent: 3, pressure: { ...QUIET.pressure!, memoryFull: 57 } },
      ["memory-pressure"],
      /^memory stalled 57% of the time/,
    ],
    [
      "12 GB with 512 MB free",
      { availableMemoryBytes: 0.5 * GIB },
      ["memory"],
      /^512 MB free, keeping 20%$/,
    ],
    [
      "swap nearly used up",
      { swapFreeBytes: 0.2 * GIB },
      ["swap"],
      /^swap nearly full: 205 MB of 4\.0 GB free$/,
    ],
    [
      "disk stalled 40%",
      { pressure: { ...QUIET.pressure!, ioFull: 40 } },
      ["io-pressure"],
      /^disk stalled 40% of the time/,
    ],
    [
      "every task waiting for a core",
      { pressure: { ...QUIET.pressure!, cpu: 95 } },
      ["cpu-pressure"],
      /^CPU saturated: work waited 95% of the time/,
    ],
    // Busy tests keep some task waiting most of the time: that alone is not a ceiling.
    [
      "tests keeping cores busy",
      { cpuPercent: 60, pressure: { ...QUIET.pressure!, cpu: 70 } },
      [],
      null,
    ],
    ["no PSI and a busy CPU", { cpuPercent: 90, pressure: null }, ["cpu"], /^CPU 90%, limit 70%$/],
    [
      "no PSI and an idle CPU under load 206",
      { load1: 206, cpuPercent: 3, pressure: null },
      [],
      null,
    ],
    // Every limit past is named, so each gauge can warn; the most urgent stays the reason.
    [
      "short of memory, swapping and a busy CPU at once",
      { availableMemoryBytes: 0.5 * GIB, swapFreeBytes: 0.2 * GIB, cpuPercent: 90 },
      ["memory", "swap", "cpu"],
      /^512 MB free, keeping 20%$/,
    ],
    // The order is the urgency: free memory first, CPU in use last.
    [
      "every limit past at once",
      {
        availableMemoryBytes: 0.5 * GIB,
        swapFreeBytes: 0.2 * GIB,
        cpuPercent: 90,
        pressure: { cpu: 95, memorySome: 60, memoryFull: 57, ioFull: 40 },
      },
      ["memory", "memory-pressure", "swap", "io-pressure", "cpu-pressure", "cpu"],
      /^512 MB free, keeping 20%$/,
    ],
  ])("%s", (_name, reading, limits, reason) => {
    const over = linuxOverBy({ ...QUIET, ...reading }, machine);
    expect(over.map((item) => item.limit)).toEqual(limits);
    if (reason === null) expect(over).toEqual([]);
    else expect(linuxOverText(over[0]!)).toMatch(reason);
  });
});

const CONTAINER: LinuxOutside = {
  cgroup: "/system.slice/docker-0123.scope",
  pid: 900,
  cpu: 5.8,
  memoryBytes: 7 * GIB,
  command: "node ci.js",
  container: { id: "0123456789ab", name: "erp-ci-3", image: "node:22" },
};

describe("admission on Linux reserves each job's memory", () => {
  const SUITE = "vp test run";
  // Learned peaks: the suite with its mysql container reached 4 GB, the lint 1 GB.
  const linuxHistory = {
    "vp test run": [{ durationMs: 60_000, memoryBytes: 4 * GIB }],
    "vp lint": [{ durationMs: 10_000, memoryBytes: 1 * GIB }],
  };
  it.each<{
    name: string;
    running: ReadonlyArray<HeavyQueueEntry>;
    outside?: ReadonlyArray<LinuxOutside>;
    free: number;
    waiting: string;
    linux: "linux-start" | "linux-wait";
    hybrid: "linux-start" | "mac-start";
  }>([
    {
      // 3 GB free, 2.4 GB kept spare, a running suite still 3 GB short of its 4 GB peak.
      name: "a suite still growing holds back the next",
      running: [onLinux("a", SUITE, 1 * GIB)],
      free: 3 * GIB,
      waiting: "vp lint",
      linux: "linux-wait",
      hybrid: "mac-start",
    },
    {
      name: "a suite at its peak leaves room for a lint",
      running: [onLinux("a", SUITE, 4 * GIB)],
      free: 4 * GIB,
      waiting: "vp lint",
      linux: "linux-start",
      hybrid: "linux-start",
    },
    {
      name: "a second suite does not fit beside one at its peak",
      running: [onLinux("a", SUITE, 4 * GIB)],
      free: 6 * GIB,
      waiting: SUITE,
      linux: "linux-wait",
      hybrid: "mac-start",
    },
    {
      // A running job no heartbeat measured yet counts its whole estimate as still to come.
      name: "an unmeasured run reserves all of its estimate",
      running: [onLinux("a", SUITE)],
      free: 6 * GIB,
      waiting: "vp lint",
      linux: "linux-wait",
      hybrid: "mac-start",
    },
    {
      // One job always runs: a job bigger than what is free still starts on an empty Linux.
      name: "an empty Linux takes a job bigger than its free memory",
      running: [],
      free: 3 * GIB,
      waiting: SUITE,
      linux: "linux-start",
      hybrid: "linux-start",
    },
    {
      // The ERP incident: 16 containers started by ssh, outside the queue, hold 7 GB of a 12 GB PC.
      name: "work outside the queue makes Linux not empty: a job must fit beside it",
      running: [],
      outside: [CONTAINER],
      free: 3 * GIB,
      waiting: SUITE,
      linux: "linux-wait",
      hybrid: "mac-start",
    },
    {
      name: "a job that fits beside work outside the queue starts",
      running: [],
      outside: [CONTAINER],
      free: 4 * GIB,
      waiting: "vp lint",
      linux: "linux-start",
      hybrid: "linux-start",
    },
  ])("$name", ({ running, outside, free, waiting, linux, hybrid }) => {
    const entries = [...running, job("w", waiting)];
    for (const [where, expected] of [
      ["linux", linux],
      ["automatic", hybrid],
    ] as const) {
      const plan = planRoutes(
        input(entries, where, {
          linuxHistory,
          health: health({ availableMemoryBytes: free, ...(outside ? { outside } : {}) }),
          // Hybrid: the Mac has a job of its own, so the tie goes to Linux when it fits.
          ...(where === "automatic"
            ? { entries: [job("m", "vp build", { startedAt: ago(5000) }), ...entries] }
            : {}),
        }),
      );
      const admit = plan.admits.w;
      const outcome = admit === undefined ? `${plan.routes.w}-wait` : `${admit.runner}-start`;
      expect(outcome).toBe(expected);
      if (expected === "linux-wait") {
        expect(plan.reasons.w).toMatch(
          outside === undefined ? /held for running jobs/ : /outside the queue/,
        );
      }
    }
  });

  it("the incident: jobs past 12 GB never start there, they wait or go to the Mac", () => {
    // Two unmeasured suites running (8 GB still to come), 1.5 GB free, memory full 57%, free slots.
    const running = [onLinux("a", SUITE), onLinux("b", SUITE)];
    const waiting = ["c", "d", "e"].map((id) => job(id, SUITE));
    const incident = health({
      availableMemoryBytes: 1.5 * GIB,
      load1: 206,
      cpuPercent: 3,
      pressure: { cpu: 1, memorySome: 60, memoryFull: 57, ioFull: 30 },
    });
    for (const where of ["linux", "automatic"] as const) {
      const plan = planRoutes(
        input([...running, ...waiting], where, { linuxHistory, health: incident }),
      );
      expect(Object.values(plan.admits).filter((admit) => admit.runner === "linux")).toEqual([]);
      if (where === "linux") for (const w of waiting) expect(plan.routes[w.id]).toBe("linux");
      else expect(plan.admits.c).toEqual({ runner: "mac", ungated: false });
    }
  });

  it("a job started this pass holds its peak against the next one", () => {
    // 7 GB free, 2.4 GB kept spare: one 4 GB suite fits, a second only if the first reserved nothing.
    const plan = planRoutes(
      input([job("a", SUITE), job("b", SUITE)], "linux", {
        linuxHistory,
        health: health({ availableMemoryBytes: 7 * GIB }),
      }),
    );
    expect(plan.admits.a).toEqual({ runner: "linux", ungated: false });
    expect(plan.admits.b).toBeUndefined();
    expect(plan.reasons.b).toMatch(/4\.0 GB held for running jobs/);
  });

  it("holds every start while Linux is not answering", () => {
    const plan = planRoutes(
      input([job("w", "vp lint")], "linux", {
        health: health({}, { failures: 1, unresponsive: true }),
      }),
    );
    expect(plan.admits.w).toBeUndefined();
    expect(plan.reasons.w).toMatch(/isn't answering/);
  });
});

describe("a memory stall stops the newest Linux run", () => {
  const three = [
    { ...onLinux("old", "vp test run"), startedAt: ago(900_000) },
    { ...onLinux("mid", "vp test run"), startedAt: ago(600_000) },
    { ...onLinux("new", "vp test run"), startedAt: ago(300_000) },
  ];
  it.each<[string, Partial<LinuxReading>, Record<string, string>]>([
    [
      "memory full 57% with free memory left",
      { pressure: { ...QUIET.pressure!, memoryFull: 57 } },
      { new: "memory" },
    ],
    ["memory full 5%", { pressure: { ...QUIET.pressure!, memoryFull: 5 } }, {}],
    ["a quiet PC", {}, {}],
  ])("%s", (_name, reading, stops) => {
    expect(linuxStops(health(reading), three, machine)).toEqual(stops);
  });
});

describe("Linux's status tells offline from not answering from over its limits", () => {
  it.each<[string, boolean, string, boolean]>([
    ["refused", false, "ssh: connect to host pc port 22: Connection refused", false],
    ["no route", false, "ssh: connect to host pc port 22: No route to host", false],
    ["powered off", false, "ssh: connect to host pc port 22: Operation timed out", false],
    ["no ssh here", false, "", false],
    ["thrashing sshd", false, "Connection timed out during banner exchange", true],
    ["heartbeat hung after login", true, "", true],
  ])("a failed check, %s, is unresponsive: %s", (_name, timedOut, stderr, expected) => {
    expect(unresponsiveFailure(timedOut, stderr)).toBe(expected);
  });

  const beat = machine.runnerHeartbeatSeconds * 1000;
  const fail = (unresponsive: boolean) => ({ ok: false as const, error: "x", unresponsive });
  const twice = (unresponsive: boolean) =>
    [1, 2].reduce<LinuxHealth>(
      (h, at) => nextHealth(h, fail(unresponsive), machine, 20_000, NOW + at * beat),
      health(),
    );
  it.each<[string, LinuxHealth, string | undefined]>([
    ["never checked", UNKNOWN_HEALTH, undefined],
    ["answering with room", health(), "online"],
    ["over its limits", health({}, { overLimit: true }), "over-limit"],
    ["two refused checks", twice(false), "offline"],
    ["two checks that timed out on a live host", twice(true), "unresponsive"],
    [
      "one timed-out check while still online",
      nextHealth(health(), fail(true), machine, 20_000, NOW + beat),
      "unresponsive",
    ],
  ])("%s", (_name, h, status) => {
    expect(linuxStatus(h)).toBe(status);
  });

  it("an answer clears not answering", () => {
    const back = nextHealth(
      twice(true),
      { ok: true, reading: QUIET },
      machine,
      20_000,
      NOW + 3 * beat,
    );
    expect(back.unresponsive).toBeUndefined();
    expect(linuxStatus(back)).toBe("online");
  });
});

// `flock(1)` is util-linux, absent on macOS: this stand-in keeps both forms the scripts use, `-n`
// on an inherited fd and `flock <file> <command>`, with flock(2) so a lock lives with its fd.
const FLOCK_SHIM = `#!/usr/bin/perl
use strict;
use Fcntl qw(:flock);
$^F = 255;
my $nb = 0;
if (@ARGV && $ARGV[0] eq "-n") { $nb = 1; shift @ARGV; }
my $target = shift @ARGV;
my $fh;
if ($target =~ /^\\d+$/) { open($fh, ">>&=", $target) or exit 1; }
else { open($fh, ">>", $target) or exit 1; }
flock($fh, LOCK_EX | ($nb ? LOCK_NB : 0)) or exit 1;
if (@ARGV) { exec { $ARGV[0] } @ARGV; exit 127; }
exit 0;
`;

describe("~/runs copies", () => {
  const withRuns = (body: (run: Runs) => void) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runs-"));
    try {
      const bin = NodePath.join(home, "bin");
      NodeFS.mkdirSync(bin);
      NodeFS.writeFileSync(NodePath.join(bin, "flock"), FLOCK_SHIM, { mode: 0o755 });
      const runs = NodePath.join(home, "runs");
      NodeFS.mkdirSync(runs);
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` };
      body({
        runs,
        sh: (script) =>
          NodeChildProcess.spawnSync("sh", ["-c", script], { env, encoding: "utf8" }).stdout.trim(),
        hold: (id) => {
          const lock = NodePath.join(runs, `${id}.lock`);
          const holder = NodeChildProcess.spawn("flock", [lock, "sleep", "60"], {
            env,
            stdio: "ignore",
          });
          for (let i = 0; i < 50; i++) {
            const free = NodeChildProcess.spawnSync("flock", ["-n", lock, "true"], { env });
            if (free.status !== 0) return holder;
            NodeChildProcess.spawnSync("sleep", ["0.1"]);
          }
          holder.kill();
          throw new Error("flock never took the lock");
        },
      });
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  };
  interface Runs {
    readonly runs: string;
    readonly sh: (script: string) => string;
    /** `remoto-rodar` holds `runs/<id>.lock` with flock for its whole run, installs included. */
    readonly hold: (id: string) => NodeChildProcess.ChildProcess;
  }
  const copy = (runs: string, id: string, daysIdle: number) => {
    NodeFS.mkdirSync(NodePath.join(runs, id, "src"), { recursive: true });
    const lock = NodePath.join(runs, `${id}.lock`);
    NodeFS.writeFileSync(lock, "");
    const at = (NOW - daysIdle * 86_400_000) / 1000;
    NodeFS.utimesSync(lock, at, at);
  };

  it("a removed worktree's copy stays while a run holds its lock", () =>
    withRuns(({ runs, sh, hold }) => {
      copy(runs, "gone-0123abcd", 0);
      const holder = hold("gone-0123abcd");
      try {
        expect(sh(removeCopyScript("gone-0123abcd"))).toBe("busy");
        expect(NodeFS.existsSync(NodePath.join(runs, "gone-0123abcd", "src"))).toBe(true);
      } finally {
        holder.kill();
      }
    }));

  it("a removal leaves no trash and no copy-shaped name, and clears trash a dropped one left", () =>
    withRuns(({ runs, sh }) => {
      copy(runs, "gone-0123abcd", 0);
      NodeFS.writeFileSync(NodePath.join(runs, "gone-0123abcd.pgid"), "999999\n");
      NodeFS.mkdirSync(NodePath.join(runs, ".trash-old-0123abcd-77", "copy"), { recursive: true });
      expect(sh(removeCopyScript("gone-0123abcd"))).toBe("removed");
      expect(NodeFS.readdirSync(runs)).toEqual(["gone-0123abcd.lock"]);
    }));

  it("never takes trash for a copy", () =>
    withRuns(({ runs, sh }) => {
      for (const trash of [".trash-idle-0123abcd-77", ".trash-idle-0123abcd-12345678"]) {
        expect(() => removeCopyScript(trash)).toThrow(/Unsafe run id/);
        copy(runs, trash, 30);
      }
      copy(runs, "idle-0123abcd", 30);
      expect(sh(idleCopiesScript(14, Math.floor(NOW / 1000)))).toBe("idle idle-0123abcd");
    }));

  it("lists only copies idle past the retention, with a lock", () =>
    withRuns(({ runs, sh }) => {
      copy(runs, "idle-0123abcd", 30);
      copy(runs, "recent-0123abcd", 2);
      NodeFS.mkdirSync(NodePath.join(runs, "nolock-0123abcd"));
      NodeFS.writeFileSync(NodePath.join(runs, "gone-0123abcd.lock"), "");
      expect(sh(idleCopiesScript(14, Math.floor(NOW / 1000)))).toBe("idle idle-0123abcd");
    }));

  it("never lists a copy a run holds, however old its lock", () =>
    withRuns(({ runs, sh, hold }) => {
      copy(runs, "busy-0123abcd", 30);
      copy(runs, "idle-0123abcd", 30);
      const holder = hold("busy-0123abcd");
      try {
        // Taking the lock does not move its time: the copy still reads 30 days idle.
        const at = (NOW - 30 * 86_400_000) / 1000;
        NodeFS.utimesSync(NodePath.join(runs, "busy-0123abcd.lock"), at, at);
        expect(sh(idleCopiesScript(14, Math.floor(NOW / 1000)))).toBe("idle idle-0123abcd");
      } finally {
        holder.kill();
      }
    }));
});
