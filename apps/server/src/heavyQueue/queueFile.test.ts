// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry } from "@t3tools/contracts";

import * as Queue from "./queueFile.ts";
import {
  DEFAULT_MACHINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  parseHeartbeat,
  type RunnerBlock,
} from "./runner.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-queue-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const entry = (id: string, pid = process.pid): HeavyQueueEntry => ({
  id,
  pid,
  threadId: null,
  label: id,
  cwd: "/",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
});
const ids = (dir: string) => Queue.read(dir).map((e) => e.id);
const deadPid = () => NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid;

describe("heavy queue file", () => {
  it("starts entries one at a time in enqueue order, and reports waiter positions", () => {
    const dir = tempDir();
    for (const id of ["a", "b", "c"]) Queue.enqueue(dir, entry(id));
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "waiting", position: 2 });
    expect(Queue.tryStart(dir, "c")).toMatchObject({ status: "waiting", position: 3 });
    expect(Queue.tryStart(dir, "a")).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "a")).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "waiting", position: 1 });
    const second = Queue.tryStart(dir, "c");
    expect(second).toMatchObject({ status: "waiting", position: 2, running: { id: "a" } });
    expect(Queue.read(dir).filter((e) => e.startedAt !== null)).toHaveLength(1);
    Queue.remove(dir, "a");
    expect(Queue.tryStart(dir, "c")).toMatchObject({ status: "waiting", position: 2 });
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "gone")).toEqual({ status: "removed" });
  });

  it("prunes entries whose process died, so the next waiter starts", () => {
    const dir = tempDir();
    Queue.enqueue(dir, entry("dead", deadPid()));
    Queue.enqueue(dir, entry("live"));
    expect(Queue.read(dir).map((e) => e.id)).toEqual(["live"]);
    expect(Queue.tryStart(dir, "live")).toMatchObject({ status: "started" });
    expect(Queue.isAlive(process.pid)).toBe(true);
    expect(Queue.isAlive(deadPid()!)).toBe(false);
  });

  it("startNow lets a waiter start past the pause and full slots, in queue order", () => {
    const dir = tempDir();
    for (const id of ["a", "b", "c", "d"]) Queue.enqueue(dir, entry(id));
    Queue.setMaxRunning(dir, 1);
    expect(Queue.tryStart(dir, "a")).toMatchObject({ status: "started" });
    Queue.setPaused(dir, true);
    expect(Queue.startNow(dir, "d")).toBe("ok");
    expect(Queue.startNow(dir, "c")).toBe("ok");
    expect(Queue.startNow(dir, "a")).toBe("running");
    expect(Queue.startNow(dir, "nope")).toBe("not-found");
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "waiting", paused: true });
    expect(Queue.tryStart(dir, "d")).toMatchObject({ status: "waiting", position: 3 });
    expect(Queue.tryStart(dir, "c")).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "d")).toMatchObject({ status: "started" });
    expect(Queue.read(dir).filter((e) => e.startedAt !== null)).toHaveLength(3);
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "waiting" });
  });

  it("promotes a waiter ahead of waiters but never ahead of the running entry", () => {
    const dir = tempDir();
    for (const id of ["a", "b", "c", "d"]) Queue.enqueue(dir, entry(id));
    expect(Queue.promote(dir, "c")).toBe("ok");
    expect(ids(dir)).toEqual(["c", "a", "b", "d"]);
    Queue.tryStart(dir, "c");
    expect(Queue.promote(dir, "d")).toBe("ok");
    expect(ids(dir)).toEqual(["c", "d", "a", "b"]);
    expect(Queue.promote(dir, "c")).toBe("running");
    expect(Queue.promote(dir, "nope")).toBe("not-found");
  });

  it("cancels a waiter without reordering others, and refuses the running entry", () => {
    const dir = tempDir();
    for (const id of ["a", "b", "c"]) Queue.enqueue(dir, entry(id));
    Queue.tryStart(dir, "a");
    expect(Queue.cancel(dir, "b")).toBe("ok");
    expect(ids(dir)).toEqual(["a", "c"]);
    expect(Queue.cancel(dir, "a")).toBe("running");
    expect(Queue.cancel(dir, "b")).toBe("not-found");
    expect(ids(dir)).toEqual(["a", "c"]);
  });

  it("treats a missing or corrupt file as empty, and a non-array body too", () => {
    const dir = tempDir();
    expect(Queue.read(dir)).toEqual([]);
    for (const body of ["{not json", '{"entries":"x"}', "null"]) {
      NodeFS.writeFileSync(NodePath.join(dir, "queue.json"), body);
      expect(Queue.read(dir)).toEqual([]);
    }
    Queue.enqueue(dir, entry("a"));
    expect(ids(dir)).toEqual(["a"]);
  });

  it("clears a stale lock instead of waiting forever", () => {
    const dir = tempDir();
    const lock = NodePath.join(dir, "lock");
    NodeFS.mkdirSync(lock);
    const old = new Date(0);
    NodeFS.utimesSync(lock, old, old);
    Queue.enqueue(dir, entry("a"));
    expect(ids(dir)).toEqual(["a"]);
    expect(NodeFS.existsSync(lock)).toBe(false);
  });

  it.each([
    {
      name: "first goes ahead of normal waiters, FIFO among firsts",
      cwds: ["/n1", "/f/a", "/n2", "/f/b"],
      expected: ["f/a", "f/b", "n1", "n2"],
    },
    {
      name: "last goes behind, normal goes before lasts",
      cwds: ["/l/a", "/n1", "/l/b", "/n2"],
      expected: ["n1", "n2", "l/a", "l/b"],
    },
    {
      name: "the user's own jobs and high ones go first, ahead of a project's last rule",
      cwds: ["/n1", "/l/user", "/n2", "/l/high"],
      expected: ["l/user", "l/high", "n1", "n2"],
      priorities: { "l/user": "normal", "l/high": "high", n1: "low", n2: "low" } as const,
    },
    {
      name: "the most specific rule wins",
      cwds: ["/n", "/f/sub/x", "/f/other"],
      expected: ["f/other", "n", "f/sub/x"],
      extra: [{ root: "/f/sub", priority: "last" as const }],
    },
  ])("orders new entries by project priority: $name", (row) => {
    const { cwds, expected, extra = [] } = row;
    const priorities: Readonly<Record<string, "low" | "normal" | "high">> =
      "priorities" in row ? row.priorities : {};
    const dir = tempDir();
    Queue.setRule(dir, "/f/", "first");
    Queue.setRule(dir, "/l", "last");
    for (const rule of extra) Queue.setRule(dir, rule.root, rule.priority);
    for (const cwd of cwds) {
      const id = cwd.slice(1);
      const priority = priorities[id];
      Queue.enqueue(dir, { ...entry(id), cwd, ...(priority === undefined ? {} : { priority }) });
    }
    expect(ids(dir)).toEqual(expected);
  });

  it("never puts a first-priority arrival ahead of the running entry or a hand-moved waiter", () => {
    const dir = tempDir();
    Queue.setRule(dir, "/f", "first");
    for (const id of ["a", "b", "c"]) Queue.enqueue(dir, entry(id));
    Queue.tryStart(dir, "a");
    Queue.move(dir, "c", "b", "Moved by the user");
    Queue.enqueue(dir, { ...entry("f1"), cwd: "/f/x" });
    expect(ids(dir)).toEqual(["a", "c", "f1", "b"] as string[]);
    expect(Queue.read(dir).find((e) => e.id === "c")).toMatchObject({
      pinned: true,
      note: "Moved by the user",
    });
  });

  it("high starts a waiter at once and low takes it back; a running job only records the level", () => {
    const dir = tempDir();
    for (const id of ["a", "b"]) Queue.enqueue(dir, { ...entry(id), priority: "low" });
    Queue.tryStart(dir, "a");
    Queue.setPaused(dir, true);
    expect(Queue.setPriority(dir, "b", "high")).toMatchObject({
      result: "ok",
      entry: { id: "b", priority: "high", forced: true },
    });
    expect(Queue.setPriority(dir, "b", "low").entry).not.toHaveProperty("forced");
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "waiting", paused: true });
    Queue.setPriority(dir, "b", "high");
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "started" });
    expect(Queue.setPriority(dir, "a", "high")).toMatchObject({
      result: "ok",
      entry: { id: "a", priority: "high" },
    });
    expect(Queue.read(dir).find((e) => e.id === "a")).not.toHaveProperty("forced");
    expect(Queue.setPriority(dir, "gone", "high")).toEqual({ result: "not-found" });
  });

  it("gives a starting job the cores free now as its worker count, and keeps it", () => {
    const dir = tempDir();
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    Queue.recordSample(
      dir,
      { at: now, busyCores: 6.2, cpuCount: 10, availableMemoryBytes: 8, totalMemoryBytes: 10 },
      {},
    );
    Queue.enqueue(dir, entry("a"));
    expect(Queue.tryStart(dir, "a", now)).toEqual({ status: "started", workers: 3 });
    expect(Queue.tryStart(dir, "a", now + 60_000)).toEqual({ status: "started", workers: 3 });
    expect(Queue.read(dir)[0]).toMatchObject({ workers: 3 });
    Queue.enqueue(dir, entry("stale"));
    Queue.setEnabled(dir, false);
    // With the queue off nothing caps it: it starts ungated.
    expect(Queue.tryStart(dir, "stale", now + 60_000)).toEqual({
      status: "started",
      workers: null,
      ungated: true,
    });
  });

  it("clears a rule and keeps rules and pause across other mutations", () => {
    const dir = tempDir();
    Queue.setRule(dir, "/f", "first");
    Queue.setPaused(dir, true);
    Queue.enqueue(dir, entry("a"));
    Queue.remove(dir, "a");
    expect(Queue.readDoc(dir)).toMatchObject({
      paused: true,
      rules: [{ root: "/f", priority: "first" }],
    });
    Queue.setRule(dir, "/f/", null);
    expect(Queue.readDoc(dir).rules).toEqual([]);
  });

  it("switched off, every waiter starts in any order; back on, new arrivals wait again", () => {
    const dir = tempDir();
    const file = NodePath.join(dir, "queue.json");
    expect(Queue.readDoc(dir).enabled).toBe(true);
    Queue.setRule(dir, "/last", "last");
    Queue.setMaxRunning(dir, 1);
    Queue.enqueue(dir, { ...entry("sim"), label: "xcrun simctl boot x" });
    Queue.tryStart(dir, "sim");
    for (const id of ["a", "b", "c"]) Queue.enqueue(dir, entry(id));
    Queue.setPaused(dir, true);
    expect(Queue.tryStart(dir, "c")).toMatchObject({ status: "waiting", position: 3 });

    Queue.setEnabled(dir, false);
    expect(Queue.readPlan(dir).plan.reasons).toEqual({});
    expect(Queue.tryStart(dir, "c")).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "a")).toMatchObject({ status: "started" });
    Queue.enqueue(dir, { ...entry("late"), cwd: "/last" });
    expect(Queue.tryStart(dir, "late")).toMatchObject({ status: "started" });
    expect(Queue.readDoc(dir)).toMatchObject({ enabled: false, paused: true, maxRunning: 1 });

    Queue.setEnabled(dir, true);
    Queue.setPaused(dir, false);
    Queue.enqueue(dir, entry("d"));
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "waiting", position: 1 });
    expect(Queue.tryStart(dir, "d")).toMatchObject({ status: "waiting", position: 2 });
    expect(
      Queue.read(dir)
        .filter((e) => e.startedAt !== null)
        .map((e) => e.id),
    ).toEqual(["sim", "c", "a", "late"]);
    expect(JSON.parse(NodeFS.readFileSync(file, "utf8")).enabled).toBe(true);
  });

  it.each([
    { body: '{"entries":[]}', enabled: true },
    { body: '{"enabled":"no"}', enabled: true },
    { body: '{"enabled":null}', enabled: true },
    { body: '{"enabled":false}', enabled: false },
    { body: "[1]", enabled: true },
  ])("reads $body as enabled $enabled, and keeps keys it does not know", ({ body, enabled }) => {
    const dir = tempDir();
    const file = NodePath.join(dir, "queue.json");
    NodeFS.writeFileSync(file, body);
    expect(Queue.readDoc(dir).enabled).toBe(enabled);
    NodeFS.writeFileSync(file, JSON.stringify({ enabled, later: { kept: 1 } }));
    Queue.setPaused(dir, true);
    Queue.enqueue(dir, entry("a"));
    expect(JSON.parse(NodeFS.readFileSync(file, "utf8"))).toMatchObject({
      enabled,
      paused: true,
      later: { kept: 1 },
      entries: [{ id: "a" }],
    });
  });

  it("moves a waiter before another or to the end, and refuses the running entry", () => {
    const dir = tempDir();
    for (const id of ["a", "b", "c", "d"]) Queue.enqueue(dir, entry(id));
    Queue.tryStart(dir, "a");
    expect(Queue.move(dir, "d", "b")).toBe("ok");
    expect(ids(dir)).toEqual(["a", "d", "b", "c"]);
    expect(Queue.move(dir, "d", null)).toBe("ok");
    expect(ids(dir)).toEqual(["a", "b", "c", "d"]);
    expect(Queue.move(dir, "b", "b")).toBe("ok");
    expect(Queue.move(dir, "b", "a")).toBe("running");
    expect(Queue.move(dir, "a", "b")).toBe("running");
    expect(Queue.move(dir, "x", "b")).toBe("not-found");
    expect(Queue.move(dir, "b", "x")).toBe("not-found");
    expect(Queue.promote(dir, "b", "by agent")).toBe("ok");
    expect(ids(dir)).toEqual(["a", "b", "c", "d"]);
  });

  it("pause holds back every waiter but lets the running entry continue", () => {
    const dir = tempDir();
    Queue.enqueue(dir, entry("a"));
    Queue.enqueue(dir, entry("b"));
    Queue.setPaused(dir, true);
    expect(Queue.tryStart(dir, "a")).toEqual({
      status: "waiting",
      position: 1,
      paused: true,
      reason: "paused",
    });
    Queue.setPaused(dir, false);
    expect(Queue.tryStart(dir, "a")).toMatchObject({ status: "started" });
    Queue.setPaused(dir, true);
    expect(Queue.tryStart(dir, "a")).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "waiting", position: 1 });
  });

  it("stops a running `t3 heavy` waiter by signal, but never itself", () => {
    const dir = tempDir();
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"]);
    try {
      Queue.enqueue(dir, entry("held", child.pid));
      Queue.tryStart(dir, "held");
      expect(Queue.cancel(dir, "held")).toBe("ok");
      expect(Queue.read(dir).find((e) => e.id === "held")).toBeDefined();
    } finally {
      child.kill("SIGKILL");
    }
    const self = tempDir();
    Queue.enqueue(self, entry("me"));
    Queue.tryStart(self, "me");
    expect(Queue.cancel(self, "me")).toBe("running");
  });

  it("refuses to stop a server-held running entry", () => {
    const dir = tempDir();
    Queue.enqueue(dir, { ...entry("srv", process.ppid), server: true });
    Queue.tryStart(dir, "srv");
    expect(Queue.cancel(dir, "srv")).toBe("running");
  });

  it("runs several at once under the plan: settle window, slot cap, backfilled entries move up front", () => {
    const dir = tempDir();
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    const GIB = 1024 ** 3;
    const sample = {
      at: now,
      busyCores: 1,
      cpuCount: 10,
      availableMemoryBytes: 30 * GIB,
      totalMemoryBytes: 32 * GIB,
    };
    Queue.setMaxRunning(dir, 2);
    Queue.recordSample(dir, sample, {});
    for (const id of ["a", "b", "c"])
      Queue.enqueue(dir, { ...entry(id), label: "vp run typecheck" });
    expect(Queue.tryStart(dir, "a", now)).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "b", now + 5_000)).toMatchObject({
      status: "waiting",
      position: 1,
      reason: "letting the last one ramp up",
    });
    for (const offset of [8_000, 16_000, 20_000])
      Queue.recordSample(dir, { ...sample, at: now + offset }, {});
    expect(Queue.tryStart(dir, "c", now + 20_000)).toMatchObject({
      status: "waiting",
      position: 2,
    });
    expect(Queue.tryStart(dir, "b", now + 20_000)).toMatchObject({ status: "started" });
    expect(Queue.readDoc(dir).entries.map((e) => [e.id, e.startedAt !== null])).toEqual([
      ["a", true],
      ["b", true],
      ["c", false],
    ]);
    for (const offset of [28_000, 36_000, 40_000])
      Queue.recordSample(dir, { ...sample, at: now + offset }, {});
    expect(Queue.tryStart(dir, "c", now + 40_000)).toMatchObject({
      status: "waiting",
      position: 1,
      reason: "all 2 slots are busy",
    });
    expect(Queue.readPlan(dir, now + 40_000).plan.room).toBe(true);
  });

  it("learns a command's cost from a finished run, whichever way it leaves the queue", () => {
    const dir = tempDir();
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    Queue.enqueue(dir, { ...entry("a"), label: "vp run build" });
    Queue.tryStart(dir, "a", now);
    Queue.recordSample(
      dir,
      { at: now, busyCores: 0, cpuCount: 4, availableMemoryBytes: 1, totalMemoryBytes: 2 },
      {
        a: { cpu: 1.5, memoryBytes: 100 },
      },
    );
    Queue.recordSample(
      dir,
      { at: now, busyCores: 0, cpuCount: 4, availableMemoryBytes: 1, totalMemoryBytes: 2 },
      {
        a: { cpu: 0.5, memoryBytes: 300 },
      },
    );
    expect(Queue.read(dir)[0]).toMatchObject({ peakCpu: 1.5, peakMemory: 300 });
    Queue.remove(dir, "a");
    expect(Queue.readDoc(dir).history["vp run build"]).toMatchObject([
      { cpu: 1.5, memoryBytes: 300 },
    ]);
  });

  it("keeps only the last runs per command and ignores finished entries without samples", () => {
    const dir = tempDir();
    const GIB = 1024 ** 3;
    for (let i = 0; i < 7; i += 1) {
      Queue.enqueue(dir, { ...entry(`r${i}`), label: "vp run build" });
      Queue.tryStart(dir, `r${i}`);
      Queue.recordSample(
        dir,
        {
          at: 1_800_000_000_000,
          busyCores: 0,
          cpuCount: 4,
          availableMemoryBytes: GIB,
          totalMemoryBytes: GIB,
        },
        {
          [`r${i}`]: { cpu: i, memoryBytes: i * 10 },
        },
      );
      Queue.remove(dir, `r${i}`);
      Queue.enqueue(dir, { ...entry("nosample"), label: "vp run lint" });
      Queue.tryStart(dir, "nosample");
      Queue.remove(dir, "nosample");
    }
    const runs = Queue.readDoc(dir).history["vp run build"] ?? [];
    expect(runs.map((r) => r.cpu)).toEqual([2, 3, 4, 5, 6]);
    expect(Queue.readDoc(dir).history["vp run lint"]).toBeUndefined();
  });

  it("admits only after headroom held for a steady window, and a pressured sample breaks it", () => {
    const dir = tempDir();
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    const GIB = 1024 ** 3;
    const calm = { cpuCount: 10, availableMemoryBytes: 30 * GIB, totalMemoryBytes: 32 * GIB };
    for (const id of ["a", "b"]) Queue.enqueue(dir, { ...entry(id), label: "vp run typecheck" });
    Queue.tryStart(dir, "a", now - 60_000);
    const at = (offset: number, busyCores: number) =>
      Queue.recordSample(dir, { ...calm, at: now + offset, busyCores }, {});
    at(0, 1);
    at(2_000, 1);
    expect(Queue.readDoc(dir).sample?.headroomSince).toBe(now);
    at(4_000, 9.5);
    expect(Queue.readDoc(dir).sample?.headroomSince).toBeNull();
    at(6_000, 1);
    at(8_000, 1);
    expect(Queue.tryStart(dir, "b", now + 8_000)).toMatchObject({
      status: "waiting",
      reason: "waiting for steady headroom",
    });
    at(10_000, 1);
    at(12_000, 1);
    expect(Queue.tryStart(dir, "b", now + 12_000)).toMatchObject({ status: "started" });
  });

  it("restarts the steady window after a long silence between readings", () => {
    const dir = tempDir();
    const calm = { cpuCount: 4, availableMemoryBytes: 9, totalMemoryBytes: 10, busyCores: 0 };
    Queue.recordSample(dir, { ...calm, at: 1_000 }, {});
    Queue.recordSample(dir, { ...calm, at: 60_000 }, {});
    expect(Queue.readDoc(dir).sample?.headroomSince).toBe(60_000);
  });

  it("lets only one waiter sample while the reading is fresh, and takes over once it is stale", () => {
    const dir = tempDir();
    const reading = (at: number) => ({
      at,
      busyCores: 1,
      cpuCount: 10,
      availableMemoryBytes: 30,
      totalMemoryBytes: 32,
    });
    Queue.enqueue(dir, entry("a"));
    expect(Queue.recordSampleIfStale(dir, reading(1_000), 5_000)).toBe(true);
    expect(Queue.recordSampleIfStale(dir, reading(3_000), 5_000)).toBe(false);
    expect(Queue.recordSampleIfStale(dir, reading(7_000), 5_000)).toBe(true);
    expect(Queue.readDoc(dir).sample?.at).toBe(7_000);
  });
});

describe("Runner in the queue file", () => {
  const NOW = Date.parse("2026-01-01T00:10:00.000Z");
  const config = (over: Partial<typeof DEFAULT_PROJECT_CONFIG> = {}) => ({
    ...DEFAULT_PROJECT_CONFIG,
    runnerEnabled: true,
    ...over,
  });
  const block = (
    global = config(),
    projects: RunnerBlock["projects"] = [],
    publisher: RunnerBlock["publisher"] = { pid: process.pid, home: "/home", primary: true },
  ): RunnerBlock => ({ global, machine: DEFAULT_MACHINE_CONFIG, projects, publisher });
  const test = (id: string, extra: Partial<HeavyQueueEntry> = {}) => ({
    ...entry(id),
    label: "vp test run",
    cwd: `/w/${id}`,
    ...extra,
  });
  const queueWith = (runner: RunnerBlock, online: boolean | null = true) => {
    const dir = tempDir();
    Queue.publishRunner(dir, runner);
    if (online === true) Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat("") }, NOW);
    if (online === false) {
      for (let i = 0; i < DEFAULT_MACHINE_CONFIG.runnerOfflineAfterFailures; i += 1) {
        Queue.recordHealth(dir, { ok: false, error: "down" }, NOW);
      }
    }
    return dir;
  };

  it("starts a Linux-bound job on Linux with no worker cap", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    Queue.enqueue(dir, test("a"));
    expect(Queue.tryStart(dir, "a", NOW)).toEqual({
      status: "started",
      workers: null,
      runner: "linux",
    });
    expect(Queue.read(dir)[0]).toMatchObject({ runner: "linux" });
    expect(Queue.read(dir)[0]).not.toHaveProperty("workers");
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ runner: "linux", workers: null });
  });

  it("asks once with the deadline from the setting, then cancels when the action says so", () => {
    const dir = queueWith(
      block(config({ runnerWhere: "linux", runnerAskMinutes: 2, runnerDeadlineAction: "cancel" })),
      false,
    );
    Queue.enqueue(dir, test("a"));
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({
      status: "waiting",
      reason: "Linux is unavailable: asking you",
    });
    expect(Queue.read(dir)[0]!.ask).toEqual({
      reason: "unavailable",
      deadlineAt: new Date(NOW + 120_000).toISOString(),
    });
    expect(Queue.tryStart(dir, "a", NOW + 60_000)).toMatchObject({
      reason: "Linux is unavailable: waiting for your answer",
    });
    expect(Queue.tryStart(dir, "a", NOW + 120_000)).toEqual({
      status: "canceled",
      reason: "Linux is unavailable and nobody answered in time: canceled",
    });
    expect(Queue.read(dir)).toEqual([]);
  });

  it("answering sends the waiter where the user said and clears the question", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })), false);
    Queue.enqueue(dir, test("a"));
    Queue.tryStart(dir, "a", NOW);
    expect(Queue.route(dir, "a", "mac")).toBe("ok");
    expect(Queue.read(dir)[0]).toMatchObject({ route: "mac" });
    expect(Queue.read(dir)[0]).not.toHaveProperty("ask");
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ status: "started", workers: 9 });
  });

  it("refuses to send exclusive or Mac-only work to Linux, and unknown entries", () => {
    const dir = queueWith(block());
    Queue.enqueue(dir, test("x", { label: "xcodebuild test" }));
    expect(Queue.route(dir, "x", "linux")).toBe("not-allowed");
    expect(Queue.route(dir, "gone", "mac")).toBe("not-found");
  });

  it("a running job moves by stopping and waiting again; a server slot never moves", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    Queue.enqueue(dir, test("a"));
    Queue.tryStart(dir, "a", NOW);
    expect(Queue.route(dir, "a", "linux")).toBe("ok");
    expect(Queue.read(dir)[0]).not.toHaveProperty("requeue");
    expect(Queue.route(dir, "a", "mac")).toBe("ok");
    expect(Queue.read(dir)[0]).toMatchObject({ requeue: "mac" });
    Queue.enqueue(dir, test("s", { server: true, startedAt: "2026-01-01T00:00:00.000Z" }));
    expect(Queue.route(dir, "s", "mac")).toBe("running");
  });

  it("a requeued attempt drops its run fields and waits first, with what decides the next one", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    Queue.enqueue(dir, test("a"));
    Queue.enqueue(dir, test("b"));
    Queue.tryStart(dir, "a", NOW);
    Queue.setProgress(dir, "a", { phase: "running", remote: { id: "w-1", pgid: 7 } });
    expect(Queue.read(dir)[0]).toMatchObject({ phase: "running", remote: { id: "w-1", pgid: 7 } });
    expect(Queue.requeue(dir, "a", { dropped: true, unconfirmed: true, linuxFailedAt: NOW })).toBe(
      true,
    );
    const again = Queue.read(dir)[0]!;
    expect(again).toMatchObject({ id: "a", startedAt: null, dropped: true, unconfirmed: true });
    for (const key of ["runner", "phase", "remote", "requeue", "workers"]) {
      expect(again).not.toHaveProperty(key);
    }
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ status: "waiting" });
    expect(Queue.route(dir, "a", "mac")).toBe("unconfirmed");
    Queue.confirmStopped(dir, "a");
    expect(Queue.read(dir)[0]).not.toHaveProperty("unconfirmed");
    expect(Queue.requeue(dir, "gone", {})).toBe(false);
  });

  it("forcing a rerun clears the unconfirmed hold", () => {
    const dir = queueWith(block());
    Queue.enqueue(dir, test("a", { unconfirmed: true }));
    expect(Queue.route(dir, "a", "mac", true)).toBe("ok");
    expect(Queue.read(dir)[0]).not.toHaveProperty("unconfirmed");
  });

  it("only the owner or a higher-ranked publisher writes the block", () => {
    const dir = tempDir();
    expect(
      Queue.publishRunner(
        dir,
        block(config(), [], { pid: process.pid, home: "/app", primary: true }),
      ),
    ).toBe(true);
    expect(
      Queue.publishRunner(
        dir,
        block(config({ runnerEnabled: false }), [], { pid: 2, home: "/dev", primary: false }),
      ),
    ).toBe(false);
    expect(Queue.readDoc(dir).runner?.global.runnerEnabled).toBe(true);
  });

  it("health goes offline after the configured failures, and only one waiter checks at a time", () => {
    const dir = queueWith(block(), null);
    Queue.recordHealth(dir, { ok: false, error: "x" }, NOW);
    expect(Queue.readDoc(dir).linux.online).toBeNull();
    Queue.recordHealth(dir, { ok: false, error: "x" }, NOW);
    expect(Queue.readDoc(dir).linux.online).toBe(false);
    expect(Queue.claimHealthCheck(dir, 1000, NOW + 500)).toBe(false);
    expect(Queue.claimHealthCheck(dir, 1000, NOW + 2000)).toBe(true);
    expect(Queue.claimHealthCheck(dir, 1000, NOW + 2500)).toBe(false);
  });

  it("a half-written block reads as the Runner off", () => {
    const dir = tempDir();
    NodeFS.writeFileSync(
      NodePath.join(dir, "queue.json"),
      JSON.stringify({ runner: { global: {} } }),
    );
    expect(Queue.readDoc(dir).runner).toBeNull();
    expect(Queue.modeFor(Queue.readDoc(dir), "/x")).toEqual({ queue: true, runner: false });
  });

  it("resolves a worktree's folder through its main checkout, without git", () => {
    const root = tempDir();
    const main = NodePath.join(root, "main");
    const worktree = NodePath.join(root, "worktrees", "wt-1");
    NodeFS.mkdirSync(NodePath.join(main, ".git", "worktrees", "wt-1"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(worktree, "apps", "server"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(worktree, ".git"),
      `gitdir: ${NodePath.join(main, ".git", "worktrees", "wt-1")}\n`,
    );
    expect(Queue.checkoutOf(NodePath.join(worktree, "apps", "server"))).toEqual({
      root: worktree,
      aliases: [NodePath.join(main, "apps", "server")],
    });
    expect(Queue.checkoutOf(NodePath.join(main))).toEqual({ root: main, aliases: [] });
    const doc = {
      runner: block(config({ runnerOverflow: 3 }), [
        { root: main, config: config({ runnerOverflow: 9 }) },
      ]),
    };
    expect(Queue.configFor(doc, NodePath.join(worktree, "apps", "server")).runnerOverflow).toBe(9);
  });

  describe("the one gate every Bash hook goes through", () => {
    const call = (command: string, cwd = "/w/p") => ({
      tool_name: "Bash",
      cwd,
      tool_input: { command },
    });
    const PREFIX = "t3 heavy --queue-dir /q";

    it.each([
      ["queue on, Runner off", true, false, "vp test run", true],
      ["queue off, Runner off", false, false, "vp test run", false],
      ["queue off, Runner on", false, true, "vp test run", true],
      ["queue on, Runner on", true, true, "vp test run", true],
      ["Runner on unwraps remoto", false, true, "remoto vp test run", true],
      ["Runner off leaves remoto alone", true, false, "remoto vp test run", false],
    ])("%s", (_name, queue, runner, command, answered) => {
      const dir = queueWith(block(config({ runnerEnabled: runner })));
      Queue.setEnabled(dir, queue);
      const answer = Queue.answerBashCall(dir, call(command), PREFIX);
      expect(answer !== null).toBe(answered);
      if (command.startsWith("remoto") && answer !== null) {
        expect(answer.hookSpecificOutput.updatedInput.command).toContain("--runner linux");
      }
    });

    it("follows the project of the call's folder", () => {
      const dir = queueWith(
        block(config({ runnerEnabled: false }), [{ root: "/w/on", config: config() }]),
      );
      Queue.setEnabled(dir, false);
      expect(Queue.answerBashCall(dir, call("vp test run", "/w/on/src"), PREFIX)).not.toBeNull();
      expect(Queue.answerBashCall(dir, call("vp test run", "/w/off"), PREFIX)).toBeNull();
    });
  });
});
