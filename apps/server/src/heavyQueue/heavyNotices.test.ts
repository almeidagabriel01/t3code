// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";
import type { HeavyNoticesMode, HeavyQueueEntry } from "@t3tools/contracts";

import {
  deadlineRecord,
  endedRecord,
  EVENT_LOG_SIZE,
  faultOf,
  unreachableLine,
  faultRecord,
  type FaultSeen,
  groupNotices,
  type HeavyEventRecord,
  type LinuxView,
  type NoticeTick,
  parseLog,
  rawNotices,
  requeueRecord,
  shownIn,
  startRecord,
  STUCK_FLOOR_MS,
  STUCK_NO_HISTORY_MS,
  stuckJobs,
  withRecord,
} from "./heavyNotices.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const MIN = 60_000;

const entry = (patch: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id: "job-1",
  pid: 1,
  threadId: "thread-1",
  label: "pnpm test",
  cwd: "/w/app",
  createdAt: new Date(NOW - MIN).toISOString(),
  startedAt: new Date(NOW - MIN).toISOString(),
  ...patch,
});
const mac = entry();
const linux = entry({ runner: "linux", phase: "running" });

const tick = (patch: Partial<NoticeTick>): NoticeTick => ({
  records: [],
  linuxBefore: null,
  linuxAfter: null,
  stuck: [],
  queueFileError: null,
  toldMac: new Set(),
  ...patch,
});
const titles = (patch: Partial<NoticeTick>) =>
  rawNotices(tick(patch)).map(({ one, description, category, machine }) => ({
    one,
    description,
    category,
    machine,
  }));
const record = (value: HeavyEventRecord | null) => {
  if (value === null) throw new Error("expected a record");
  return value;
};
const policies = { runnerDropped: "ask", runnerUnavailable: "mac" } as const;

describe("what a job's end records", () => {
  it.each([
    [0, false],
    [125, false],
    [129, false],
    [130, false],
    [143, false],
    [1, true],
    [75, true],
    [127, true],
  ])("exit %i records a failure: %s", (code, records) => {
    expect(endedRecord(mac, code, NOW) !== null).toBe(records);
  });

  it("records nothing for an entry already gone", () => {
    expect(endedRecord(undefined, 1, NOW)).toBeNull();
  });

  it("keeps a Linux job's phase and drops a Mac one's", () => {
    expect(endedRecord({ ...linux, phase: "installing" }, 1, NOW)).toMatchObject({
      kind: "ended",
      phase: "installing",
      job: { runner: "linux", name: "pnpm test", threadId: "thread-1" },
    });
    expect(endedRecord({ ...mac, phase: "syncing" }, 1, NOW)).not.toHaveProperty("phase");
  });
});

describe("what a requeue records", () => {
  it.each([
    ["the user's move", { route: "mac" as const }, null],
    [
      "a part that needs this Mac",
      { route: "mac" as const, routeReason: "Needs git" },
      "needs-mac",
    ],
    ["a drop", { dropped: true, linuxFailedAt: NOW }, "linux-lost"],
    ["Linux unavailable at start", { linuxFailedAt: NOW }, "linux-lost"],
  ])("%s", (_name, next, kind) => {
    expect(requeueRecord(linux, next, policies, NOW)?.kind ?? null).toBe(kind);
  });

  it("takes the follow-up from the matching policy", () => {
    expect(requeueRecord(linux, { dropped: true, unconfirmed: true }, policies, NOW)).toMatchObject(
      { dropped: true, followUp: "ask", unconfirmed: true },
    );
    expect(requeueRecord(linux, { linuxFailedAt: NOW }, policies, NOW)).toMatchObject({
      dropped: false,
      followUp: "mac",
      unconfirmed: false,
    });
  });
});

describe("what an admission records", () => {
  const waiter = entry({ startedAt: null });
  it.each([
    ["Linux-bound on Linux", "linux", "linux", null],
    ["Mac-bound on the Mac", "mac", "mac", null],
    ["Hybrid on the Mac", "automatic", "mac", null],
    ["Hybrid on Linux", "automatic", "linux", "hybrid"],
    ["Mac first on the Mac", "macFirst", "mac", null],
    ["Mac first on Linux", "macFirst", "linux", null],
    ["Linux-bound on the Mac", "linux", "mac", "displaced"],
  ] as const)("%s", (_name, intent, runner, kind) => {
    expect(startRecord(waiter, intent, runner, NOW)?.kind ?? null).toBe(kind);
  });

  it.each([
    ["unavailable", waiter],
    ["dropped", { ...waiter, dropped: true }],
    [
      "deadline",
      {
        ...waiter,
        ask: { reason: "unavailable" as const, deadlineAt: new Date(NOW).toISOString() },
      },
    ],
    [
      "unavailable",
      {
        ...waiter,
        ask: { reason: "unavailable" as const, deadlineAt: new Date(NOW + MIN).toISOString() },
      },
    ],
  ])("names why it left Linux: %s", (cause, job) => {
    expect(startRecord(job, "linux", "mac", NOW)).toMatchObject({ kind: "displaced", cause });
  });
});

describe("the event log", () => {
  it("keeps the newest records and ignores nothing", () => {
    const log = Array.from({ length: EVENT_LOG_SIZE + 3 }).reduce<ReadonlyArray<HeavyEventRecord>>(
      (acc) => withRecord(acc, endedRecord(mac, 1, NOW)),
      [],
    );
    expect(log).toHaveLength(EVENT_LOG_SIZE);
    expect(withRecord(log, null)).toBe(log);
  });

  it("reads tolerantly, skipping malformed records", () => {
    const good = record(endedRecord(mac, 1, NOW));
    expect(parseLog([good, null, 3, { id: "x" }, { id: "y", kind: "ended", job: null }])).toEqual([
      good,
    ]);
    expect(parseLog("nope")).toEqual([]);
  });
});

describe("faults T3 records for the problem detector", () => {
  const job = { command: "vp test run", projectFolder: "/w/app" };
  const sync = { kind: "sync" } as const;
  it.each<[string, FaultSeen, string | null, string | null, string | null]>([
    // [case, what the CLI saw, Linux's last line, reason:cause, error the card shows]
    [
      "tool missing in the pre-flight",
      { kind: "missing", tool: "vp" },
      null,
      "command-not-found:vp",
      "vp: command not found",
    ],
    [
      "exit 127 naming the tool",
      { kind: "exit", code: 127, program: "bash" },
      "sh: 1: vp: not found",
      "command-not-found:vp",
      "sh: 1: vp: not found",
    ],
    [
      "exit 127 with no line",
      { kind: "exit", code: 127, program: "pnpm" },
      null,
      "command-not-found:pnpm",
      "pnpm: command not found",
    ],
    [
      "exit 126",
      { kind: "exit", code: 126, program: "bash" },
      "bash: ./run.sh: Permission denied",
      "command-not-found:./run.sh",
      "bash: ./run.sh: Permission denied",
    ],
    [
      "a test failing is the code's",
      { kind: "exit", code: 1, program: "vp" },
      "FAIL src/a.test.ts",
      null,
      null,
    ],
    [
      "install raced twice",
      { kind: "install", package: "electron" },
      "Error: Electron failed to install correctly",
      "linux-install:electron",
      "Error: Electron failed to install correctly",
    ],
    [
      "install with no package named",
      { kind: "install", package: null },
      null,
      "linux-install:node_modules",
      "Dependency install on Linux failed",
    ],
    [
      "install out of disk",
      { kind: "install", package: "electron" },
      "ENOSPC: no space left on device, write",
      "disk-full:install-no-space",
      "ENOSPC: no space left on device, write",
    ],
    ["sync with no line", sync, null, "linux-sync:unknown", "Linux sync failed"],
    [
      "sync out of memory",
      sync,
      "fatal: Cannot allocate memory",
      "out-of-memory:sync-no-memory",
      "fatal: Cannot allocate memory",
    ],
    [
      "sync failed in rsync itself",
      sync,
      "rsync error: some files/attrs were not transferred (code 23) at main.c(1338)",
      "linux-sync:rsync-unknown",
      "rsync error: some files/attrs were not transferred (code 23) at main.c(1338)",
    ],
    [
      "dropped with T3's own error",
      { kind: "lost" },
      "remoto-rodar: line 40: syntax error: unexpected end of file",
      "linux-lost:unknown",
      "remoto-rodar: line 40: syntax error: unexpected end of file",
    ],
    // The PC or the network being away is Linux offline, not a fault, at whatever step it shows.
    ...[
      "[remoto] PC indisponível.",
      "ssh: Could not resolve hostname pc: nodename nor servname provided, or not known",
      "ssh: Could not resolve hostname pc: Name or service not known",
      "ssh: Could not resolve hostname pc: Temporary failure in name resolution",
      "rsync error: timeout in data send/receive (code 30) at io.c(201)",
      "[sender] io timeout after 30 seconds -- exiting",
      "Connection to pc closed by remote host.",
      "Connection closed by 192.168.10.109 port 2222",
      "client_loop: send disconnect: Broken pipe",
      "read: Connection reset by peer",
      "ssh: connect to host pc port 22: Operation timed out",
      "ssh: connect to host pc port 22: Connection timed out",
      "ssh: connect to host pc port 22: Host is down",
      "ssh: connect to host pc port 22: Connection refused",
      "ssh: connect to host pc port 22: No route to host",
      "ssh: connect to host pc port 22: Network is unreachable",
    ].flatMap((line) =>
      (["unreachable", "sync", "lost"] as const).map(
        (kind): [string, FaultSeen, string | null, null, null] => [
          `${kind}: ${line}`,
          { kind },
          line,
          null,
          null,
        ],
      ),
    ),
    ["unreachable with no line", { kind: "unreachable" }, null, null, null],
    [
      "key no longer accepted",
      { kind: "unreachable" },
      "dev@pc: Permission denied (publickey).",
      "sign-in-expired:unreachable-ssh-key",
      "dev@pc: Permission denied (publickey).",
    ],
  ])("%s", (_, seen, line, expected, error) => {
    const fault = faultOf(seen, line, job);
    expect(fault === null ? null : `${fault.cause}`).toBe(expected);
    expect(fault?.error ?? null).toBe(error);
    if (fault !== null) {
      expect(fault.cause.startsWith(`${fault.reason}:`)).toBe(true);
      expect(fault).toMatchObject(job);
    }
  });

  // ssh's own line, not the rsync error after it, says the PC went away mid-sync.
  it.each([
    [
      "ssh: connect to host pc port 22: Host is down\r\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]\nrsync error: unexplained error (code 255) at io.c(232)\n",
      "ssh: connect to host pc port 22: Host is down",
    ],
    ["[remoto] PC indisponível.\n", "[remoto] PC indisponível."],
    [
      "ssh: Could not resolve hostname pc: Name or service not known\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]\nrsync error: unexplained error (code 255) at io.c(232)\n",
      "ssh: Could not resolve hostname pc: Name or service not known",
    ],
    ["Error: connect ECONNREFUSED 127.0.0.1:5432 (Connection refused)\n", null],
    ["rsync error: timeout in data send/receive (code 30) at io.c(201)\n", null],
  ])("finds the unreachable line in %j", (text, line) => {
    expect(unreachableLine(text)).toBe(line);
    if (line !== null) expect(faultOf(sync, line, job)).toBeNull();
  });

  it("gives the same cause for the same fault, whatever the numbers or paths", () => {
    const one = faultOf(
      sync,
      "rsync error: some files/attrs were not transferred (code 23) at main.c(1338)",
      job,
    );
    const two = faultOf(
      sync,
      "rsync error: some files could not be transferred (code 23) at main.c(9)",
      {
        command: "vp lint",
        projectFolder: "/w/other",
      },
    );
    expect(one?.cause).toBe("linux-sync:rsync-unknown");
    expect(two?.cause).toBe(one?.cause);
  });

  it("keeps the job's thread on the record and raises no toast", () => {
    const fault = faultOf({ kind: "missing", tool: "vp" }, null, job)!;
    const logged = faultRecord(linux, fault, NOW);
    expect(logged).toMatchObject({
      kind: "t3-fault",
      reason: "command-not-found",
      job: { id: "job-1", threadId: "thread-1", runner: "linux" },
    });
    expect(titles({ records: [logged] })).toEqual([]);
  });
});

describe("notices for each problem", () => {
  it.each([
    [
      "failed on the Mac",
      endedRecord(mac, 1, NOW),
      "pnpm test failed on this Mac",
      "Exit code 1",
      "mac",
    ],
    [
      "failed on Linux",
      endedRecord(linux, 2, NOW),
      "pnpm test failed on Linux",
      "Exit code 2",
      "linux",
    ],
    [
      "sync failed",
      endedRecord({ ...linux, phase: "syncing" }, 1, NOW),
      "Linux sync failed for pnpm test",
      "Exit code 1",
      "linux",
    ],
    [
      "install failed",
      endedRecord({ ...linux, phase: "installing" }, 1, NOW),
      "Dependency install on Linux failed for pnpm test",
      "Exit code 1",
      "linux",
    ],
    [
      "could not start on the Mac",
      endedRecord(mac, 127, NOW),
      "pnpm test could not start on this Mac",
      "Command not found or not executable (exit 127)",
      "mac",
    ],
    [
      "could not start on Linux",
      endedRecord(linux, 126, NOW),
      "pnpm test could not start on Linux",
      "Command not found or not executable (exit 126)",
      "linux",
    ],
    [
      "deadline cancel",
      deadlineRecord(entry({ startedAt: null }), NOW),
      "pnpm test was cancelled",
      "Linux was unavailable and nobody answered in time",
      "linux",
    ],
    [
      "deadline cancel after a drop",
      deadlineRecord(entry({ startedAt: null, dropped: true }), NOW),
      "pnpm test was cancelled",
      "Linux dropped it and nobody answered in time",
      "linux",
    ],
    [
      "dropped, confirming",
      requeueRecord(linux, { dropped: true, unconfirmed: true }, policies, NOW),
      "Linux dropped pnpm test mid-run",
      "Confirming the run stopped there first. Waiting for your answer in the Resource Manager",
      "linux",
    ],
    [
      "unavailable, moving",
      requeueRecord(linux, { linuxFailedAt: NOW }, policies, NOW),
      "Linux was unavailable for pnpm test",
      "Running it on this Mac instead",
      "linux",
    ],
    [
      "unavailable, waiting",
      requeueRecord(
        linux,
        { linuxFailedAt: NOW },
        { runnerDropped: "ask", runnerUnavailable: "wait" },
        NOW,
      ),
      "Linux was unavailable for pnpm test",
      "Waiting for Linux to come back",
      "linux",
    ],
    // Tell the agent: the agent gets the failure back, so the notice names no next step.
    [
      "dropped, telling the agent",
      requeueRecord(
        linux,
        { dropped: true, unconfirmed: true },
        { runnerDropped: "agent", runnerUnavailable: "ask" },
        NOW,
      ),
      "Linux dropped pnpm test mid-run",
      "Confirming the run stopped there first",
      "linux",
    ],
  ])("%s", (_name, value, one, description, machine) => {
    expect(titles({ records: [record(value)] })).toEqual([
      { one, description, category: "problem", machine },
    ]);
  });

  it("names a job by its --name and shortens long ones", () => {
    const named = record(endedRecord({ ...mac, name: "Web tests" }, 1, NOW));
    const long = record(endedRecord({ ...mac, label: "x".repeat(80) }, 1, NOW));
    expect(rawNotices(tick({ records: [named] }))[0]!.one).toBe("Web tests failed on this Mac");
    expect(rawNotices(tick({ records: [long] }))[0]!.one).toBe(
      `${"x".repeat(59)}… failed on this Mac`,
    );
  });

  const view = (online: boolean | null, okAt = 1): LinuxView => ({ host: "pc", online, okAt });
  it.each([
    [
      "went offline",
      view(true),
      { ...view(false), error: "ssh timed out" },
      "Linux went offline",
      "ssh timed out",
    ],
    ["went offline, no error", view(true), view(false), "Linux went offline", "No answer from pc"],
    [
      "came back",
      view(false),
      view(true, 2),
      "Linux is back online",
      "Jobs bound for Linux run on pc again",
    ],
  ])("Linux %s", (_name, linuxBefore, linuxAfter, one, description) => {
    expect(titles({ linuxBefore, linuxAfter })).toEqual([
      { one, description, category: "problem", machine: "linux" },
    ]);
  });

  it.each([
    ["the first reading", view(null), view(false)],
    ["no change", view(false), view(false)],
    ["the Runner turning off", view(true), null],
    ["the Runner turning on", null, view(true)],
  ])("Linux says nothing for %s", (_name, linuxBefore, linuxAfter) => {
    expect(rawNotices(tick({ linuxBefore, linuxAfter }))).toEqual([]);
  });

  it("reports an unusable queue file", () => {
    expect(titles({ queueFileError: "Cannot read queue.json" })).toEqual([
      {
        one: "The heavy queue file is not usable",
        description: "Cannot read queue.json",
        category: "problem",
        machine: "mac",
      },
    ]);
  });
});

describe("notices for machine changes", () => {
  const waiter = entry({ startedAt: null });
  it.each([
    [
      "Linux unavailable",
      startRecord(waiter, "linux", "mac", NOW),
      "Linux is unavailable",
      "unexpected",
    ],
    [
      "a drop",
      startRecord({ ...waiter, dropped: true }, "linux", "mac", NOW),
      "Linux dropped it mid-run",
      "unexpected",
    ],
    [
      "a deadline",
      startRecord(
        { ...waiter, ask: { reason: "unavailable", deadlineAt: new Date(NOW).toISOString() } },
        "linux",
        "mac",
        NOW,
      ),
      "Linux was unavailable and nobody answered in time",
      "unexpected",
    ],
    [
      "a part that needs this Mac",
      requeueRecord(linux, { route: "mac", routeReason: "Needs git" }, policies, NOW),
      "Needs git",
      "unexpected",
    ],
  ])("moved to this Mac after %s", (_name, value, description, category) => {
    expect(titles({ records: [record(value)] })).toEqual([
      { one: "pnpm test moved to this Mac", description, category, machine: "mac" },
    ]);
  });

  it("Hybrid sending a job to Linux is planned", () => {
    expect(titles({ records: [record(startRecord(waiter, "automatic", "linux", NOW))] })).toEqual([
      {
        one: "pnpm test went to Linux",
        description: "Each job goes to the machine with the shorter queue.",
        category: "planned",
        machine: "linux",
      },
    ]);
  });

  it("does not repeat a move the Linux loss notice already announced, unless a deadline made it", () => {
    const toldMac = new Set(["job-1"]);
    const moved = record(startRecord(waiter, "linux", "mac", NOW));
    const deadline = record(
      startRecord(
        { ...waiter, ask: { reason: "unavailable", deadlineAt: new Date(NOW).toISOString() } },
        "linux",
        "mac",
        NOW,
      ),
    );
    expect(rawNotices(tick({ records: [moved], toldMac }))).toEqual([]);
    expect(rawNotices(tick({ records: [deadline], toldMac }))).toHaveLength(1);
  });
});

describe("which notices each setting shows", () => {
  const notices = rawNotices(
    tick({
      records: [
        record(endedRecord(mac, 1, NOW)),
        record(startRecord(entry({ startedAt: null }), "linux", "mac", NOW)),
        record(startRecord(entry({ startedAt: null }), "automatic", "linux", NOW)),
      ],
    }),
  );
  it.each([
    ["unexpected", ["problem", "unexpected"]],
    ["every-move", ["problem", "unexpected", "planned"]],
    ["problems", ["problem"]],
    ["off", []],
  ] as const)("%s", (mode: HeavyNoticesMode, categories) => {
    expect(notices.filter((notice) => shownIn(mode, notice)).map((n) => n.category)).toEqual(
      categories,
    );
  });
});

describe("jobs stuck waiting", () => {
  const waiting = (minutes: number, patch: Partial<HeavyQueueEntry> = {}) =>
    entry({ startedAt: null, createdAt: new Date(NOW - minutes * MIN).toISOString(), ...patch });
  const stuck = (patch: Partial<Parameters<typeof stuckJobs>[0]>) =>
    stuckJobs({
      entries: [],
      routes: {},
      macHold: "cpu",
      macHoldText: "CPU busy",
      linuxOver: {},
      usualMs: () => null,
      now: NOW,
      ...patch,
    }).map((job) => job.job.id);

  it.each([
    ["no history, past the limit", waiting(STUCK_NO_HISTORY_MS / MIN + 1), () => null, true],
    ["no history, under the limit", waiting(STUCK_NO_HISTORY_MS / MIN - 1), () => null, false],
    ["short usual run, past the floor", waiting(STUCK_FLOOR_MS / MIN + 1), () => MIN, true],
    ["short usual run, under the floor", waiting(STUCK_FLOOR_MS / MIN - 1), () => MIN, false],
    ["long usual run, under three runs", waiting(50), () => 20 * MIN, false],
    ["long usual run, past three runs", waiting(61), () => 20 * MIN, true],
  ])("%s", (_name, job, usualMs, expected) => {
    expect(stuck({ entries: [job], usualMs })).toEqual(expected ? ["job-1"] : []);
  });

  it.each([
    ["the Mac is over its CPU limit", { macHold: "cpu" as const }, true],
    ["the job's own need is over what is free", { macHold: "job-memory" as const }, true],
    ["the queue is paused", { macHold: "paused" as const }, false],
    ["the slots are busy", { macHold: "slots" as const }, false],
    ["nothing holds it", { macHold: null }, false],
  ])("on this Mac while %s: %s", (_name, patch, expected) => {
    expect(stuck({ entries: [waiting(40)], ...patch })).toEqual(expected ? ["job-1"] : []);
  });

  it("on Linux only while Linux's limits hold that job, timed by its Linux runs", () => {
    const routes = { "job-1": "linux" as const };
    const linuxOver = { "job-1": "1.8 GB free, keeping 20%" };
    const usualMs = (_: HeavyQueueEntry, runner: string) => (runner === "linux" ? 20 * MIN : null);
    expect(stuck({ entries: [waiting(61)], routes, linuxOver, usualMs })).toEqual(["job-1"]);
    expect(stuck({ entries: [waiting(50)], routes, linuxOver, usualMs })).toEqual([]);
    // Slots, an offline PC or another reason: not over its limits.
    expect(stuck({ entries: [waiting(61)], routes, usualMs })).toEqual([]);
  });

  it("never for a running job or one waiting for the user's answer", () => {
    const asked = waiting(40, {
      ask: { reason: "unavailable", deadlineAt: new Date(NOW).toISOString() },
    });
    expect(stuck({ entries: [entry({ createdAt: waiting(40).createdAt }), asked] })).toEqual([]);
  });

  it("words the notice with the hold and the usual time", () => {
    const [job] = stuckJobs({
      entries: [waiting(40)],
      routes: {},
      macHold: "cpu",
      macHoldText: "CPU busy",
      linuxOver: {},
      usualMs: () => 2 * MIN,
      now: NOW,
    });
    expect(titles({ stuck: [job!] })).toEqual([
      {
        one: "pnpm test has waited 40 min on this Mac",
        description: "This Mac stays over its limits: CPU busy. It usually takes 2 min",
        category: "problem",
        machine: "mac",
      },
    ]);
  });
});

describe("grouping", () => {
  const failed = (id: string, name: string, runner: "mac" | "linux" = "mac") =>
    record(endedRecord(entry({ id, label: name, runner, threadId: `t-${id}` }), 1, NOW));

  it("folds jobs of one kind and machine into one toast without a thread", () => {
    const notices = rawNotices(tick({ records: [failed("a", "lint"), failed("b", "test")] }));
    const { batch } = groupNotices(notices, new Map(), NOW);
    expect(batch).toEqual([
      {
        id: notices[0]!.seed,
        tone: "error",
        title: "2 jobs failed on this Mac",
        description: "Exit code 1",
        machine: "mac",
        threadId: null,
      },
    ]);
  });

  it("keeps one job's thread and separates machines", () => {
    const { batch } = groupNotices(
      rawNotices(tick({ records: [failed("a", "lint"), failed("b", "test", "linux")] })),
      new Map(),
      NOW,
    );
    expect(batch.map(({ title, threadId }) => ({ title, threadId }))).toEqual([
      { title: "lint failed on this Mac", threadId: "t-a" },
      { title: "test failed on Linux", threadId: "t-b" },
    ]);
  });

  it("lists names when the jobs' details differ", () => {
    const one = record(endedRecord(entry({ id: "a", label: "lint" }), 1, NOW));
    const two = record(endedRecord(entry({ id: "b", label: "test" }), 2, NOW));
    const { batch } = groupNotices(rawNotices(tick({ records: [one, two] })), new Map(), NOW);
    expect(batch[0]!.description).toBe("lint, test");
  });

  it("grows the same toast within the window, then starts a new one", () => {
    const first = groupNotices(
      rawNotices(tick({ records: [failed("a", "lint")] })),
      new Map(),
      NOW,
    );
    const second = groupNotices(
      rawNotices(tick({ records: [failed("b", "test")] })),
      first.open,
      NOW + 10_000,
    );
    expect(second.batch).toEqual([
      expect.objectContaining({ id: first.batch[0]!.id, title: "2 jobs failed on this Mac" }),
    ]);
    const later = groupNotices(
      rawNotices(tick({ records: [failed("c", "build")] })),
      second.open,
      NOW + 61_000,
    );
    expect(later.batch).toEqual([
      expect.objectContaining({ title: "build failed on this Mac", threadId: "t-c" }),
    ]);
    expect(later.batch[0]!.id).not.toBe(first.batch[0]!.id);
  });

  it("does not count the same job twice", () => {
    const notices = rawNotices(tick({ records: [failed("a", "lint"), failed("a", "lint")] }));
    expect(groupNotices(notices, new Map(), NOW).batch[0]!.title).toBe("lint failed on this Mac");
  });

  const waiter = entry({ startedAt: null });
  const lost = (online: boolean) => ({ host: "pc", online, okAt: online ? 2 : 1 });
  it.each([
    [{ records: [record(endedRecord(mac, 127, NOW))] }, "3 jobs could not start on this Mac"],
    [
      { records: [record(endedRecord({ ...linux, phase: "syncing" }, 1, NOW))] },
      "Linux sync failed for 3 jobs",
    ],
    [{ records: [record(deadlineRecord(waiter, NOW))] }, "3 jobs were cancelled"],
    [
      { records: [record(requeueRecord(linux, { dropped: true }, policies, NOW))] },
      "Linux dropped 3 jobs mid-run",
    ],
    [
      { records: [record(requeueRecord(linux, { linuxFailedAt: NOW }, policies, NOW))] },
      "Linux was unavailable for 3 jobs",
    ],
    [{ records: [record(startRecord(waiter, "linux", "mac", NOW))] }, "3 jobs moved to this Mac"],
    [
      {
        records: [
          record(requeueRecord(linux, { route: "mac", routeReason: "Needs git" }, policies, NOW)),
        ],
      },
      "3 jobs moved to this Mac",
    ],
    [{ records: [record(startRecord(waiter, "automatic", "linux", NOW))] }, "3 jobs went to Linux"],
    [{ linuxBefore: lost(true), linuxAfter: lost(false) }, "Linux went offline"],
    [{ linuxBefore: lost(false), linuxAfter: lost(true) }, "Linux is back online"],
    [{ queueFileError: "EACCES" }, "The heavy queue file is not usable"],
  ] as const)("titles several jobs: %#", (patch, title) => {
    expect(rawNotices(tick(patch)).map((notice) => notice.many(3))).toEqual([title]);
  });

  it("titles several stuck jobs", () => {
    const stuck = stuckJobs({
      entries: [waiter],
      routes: {},
      macHold: "cpu",
      macHoldText: "CPU busy",
      linuxOver: {},
      usualMs: () => null,
      now: NOW + 40 * MIN,
    });
    expect(rawNotices(tick({ stuck })).map((notice) => notice.many(3))).toEqual([
      "3 jobs are stuck waiting on this Mac",
    ]);
  });

  it("sends nothing for an empty tick", () => {
    expect(groupNotices([], new Map(), NOW).batch).toEqual([]);
  });
});
