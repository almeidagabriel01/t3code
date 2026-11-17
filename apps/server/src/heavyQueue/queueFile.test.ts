// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry, RunnerProjectConfig } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

// Counts the queue file's writes; every call goes through to the real rename.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import * as Queue from "./queueFile.ts";
import {
  DEFAULT_MACHINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  parseHeartbeat,
  runnerCopyId,
  type RunnerBlock,
} from "./runner.ts";
import {
  drainLostRuns,
  type readRemotePgid,
  type StopResult,
  type stopRemote,
} from "./runnerExec.ts";

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
    // With no project on the Runner the line names no machine, as it always read.
    expect(second).not.toHaveProperty("runner");
    expect(Queue.read(dir).filter((e) => e.startedAt !== null)).toHaveLength(1);
    Queue.remove(dir, "a");
    expect(Queue.tryStart(dir, "c")).toMatchObject({ status: "waiting", position: 2 });
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "gone")).toEqual({ status: "removed" });
  });

  it.each([
    ["waiting", false, 0, "attached"],
    ["running", true, 0, "attached"],
    ["ended with 3", false, 3, { code: 3 }],
    ["ended over an hour ago", false, -1, "added"],
  ] as const)(
    "a repeated request whose job is %s is not added again",
    (_state, start, code, result) => {
      const dir = tempDir();
      const at = Date.parse("2026-01-01T00:00:00.000Z");
      expect(Queue.enqueue(dir, entry("req-1"), at)).toBe("added");
      if (start) Queue.tryStart(dir, "req-1", at);
      if (code !== 0) Queue.finish(dir, "req-1", Math.abs(code), at);
      const later = at + (code < 0 ? 3_600_001 : 1000);
      expect(Queue.enqueue(dir, entry("req-1"), later)).toEqual(result);
      expect(ids(dir)).toEqual(code > 0 ? [] : ["req-1"]);
    },
  );

  it("keeps the last 200 results", () => {
    const dir = tempDir();
    const at = Date.parse("2026-01-01T00:00:00.000Z");
    for (let n = 0; n < 201; n += 1) Queue.finish(dir, `r${n}`, 1, at);
    expect(Queue.enqueue(dir, entry("r0"), at)).toBe("added");
    expect(Queue.enqueue(dir, entry("r200"), at)).toEqual({ code: 1 });
  });

  it("reads a script up to 64 KB from the folder, and nothing else", () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, "small.sh"), "vp test run");
    NodeFS.writeFileSync(NodePath.join(dir, "big.sh"), "x".repeat(64 * 1024 + 1));
    NodeFS.mkdirSync(NodePath.join(dir, "folder.sh"));
    const read = Queue.scriptReader(dir, dir);
    expect(read("small.sh")).toBe("vp test run");
    expect(read(`${dir}/small.sh`)).toBe("vp test run");
    expect(read("~/small.sh")).toBe("vp test run");
    expect(read("big.sh")).toBeNull();
    expect(read("folder.sh")).toBeNull();
    expect(read("missing.sh")).toBeNull();
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

  it("startNow lets every chosen waiter start past the pause and full slots", () => {
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
    expect(Queue.tryStart(dir, "d")).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "c")).toMatchObject({ status: "started" });
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

  // A group of 0 or 1 is never a run's own: `kill -- -1` would reach every process there.
  it.each([0, 1, -2, 1.5, "7", 42])(
    "reads a stored process group of %j only as a real one",
    (pgid) => {
      const dir = tempDir();
      const remote = { id: "w-1", pgid };
      NodeFS.writeFileSync(
        NodePath.join(dir, "queue.json"),
        JSON.stringify({
          entries: [{ ...entry("a"), remote }],
          lostRuns: [{ key: "k", entryId: "a", cwd: "/w", remote }],
        }),
      );
      const real = pgid === 42 ? 42 : null;
      expect(Queue.read(dir)[0]!.remote).toEqual(real === null ? { id: "w-1" } : remote);
      expect(Queue.readDoc(dir).lostRuns[0]!.remote).toEqual({ id: "w-1", pgid: real });
    },
  );

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

  it("high starts a waiter at once and low takes it back; a running job keeps its place and records QoS apart", () => {
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
    // An agent's job waits "low" yet runs at normal QoS: the two never share a field.
    expect(Queue.read(dir).find((e) => e.id === "a")).not.toHaveProperty("qos");
    // The user's choice for a running job is kept, and T3 stops slowing it on its own.
    Queue.recordSlowdown(dir, { slowed: ["a", "missing"], restored: [], slowedDaemons: [] });
    expect(Queue.read(dir).find((e) => e.id === "a")).toMatchObject({ slowed: true });
    expect(Queue.setPriority(dir, "a", "high")).toMatchObject({
      result: "ok",
      entry: { id: "a", priority: "high" },
    });
    expect(Queue.read(dir).find((e) => e.id === "a")).not.toHaveProperty("forced");
    expect(Queue.read(dir).find((e) => e.id === "a")).not.toHaveProperty("slowed");
    Queue.setQos(dir, "a", "background");
    Queue.setQos(dir, "waiter-never-started", "normal");
    expect(Queue.read(dir).find((e) => e.id === "a")).toMatchObject({
      priority: "high",
      qos: "background",
    });
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

  it("runs several at once under the plan: a fresh start counts its estimate, slots cap the rest", () => {
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
    for (const id of ["a", "b", "c"])
      Queue.enqueue(dir, { ...entry(id), label: "vp run typecheck" });
    Queue.recordSample(dir, sample, {});
    expect(Queue.tryStart(dir, "a", now)).toMatchObject({ status: "started" });
    Queue.recordSample(dir, { ...sample, at: now + 7_000 }, {});
    expect(Queue.tryStart(dir, "c", now + 7_000)).toMatchObject({
      status: "waiting",
      position: 2,
    });
    expect(Queue.tryStart(dir, "b", now + 7_000)).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "c", now + 7_000)).toMatchObject({
      status: "waiting",
      position: 1,
      reason: "all 2 slots busy",
    });
    expect(Queue.readPlan(dir, now + 7_000).plan.room).toBe(true);
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
        a: { cpu: 0.5, memoryBytes: 300, treeMemoryBytes: 120, daemons: [7] },
      },
    );
    expect(Queue.read(dir)[0]).toMatchObject({
      peakCpu: 1.5,
      peakMemory: 300,
      peakTreeMemory: 120,
    });
    // Processes the sample could not read: CPU unknown, memory still counts.
    Queue.recordSample(
      dir,
      { at: now, busyCores: 0, cpuCount: 4, availableMemoryBytes: 1, totalMemoryBytes: 2 },
      { a: { cpu: null, memoryBytes: 200 } },
    );
    expect(Queue.read(dir)[0]).toMatchObject({ memory: 200, peakCpu: 1.5 });
    expect(Queue.read(dir)[0]!.cpu).toBeUndefined();
    Queue.remove(dir, "a");
    expect(Queue.readDoc(dir).history["vp run build"]).toMatchObject([
      { cpu: 1.5, memoryBytes: 300, treeMemoryBytes: 120 },
    ]);
    // A job whose CPU was never read leaves a run without CPU, never a 0.
    Queue.enqueue(dir, { ...entry("b"), label: "vp run build" });
    Queue.tryStart(dir, "b", now);
    Queue.recordSample(
      dir,
      { at: now, busyCores: 0, cpuCount: 4, availableMemoryBytes: 1, totalMemoryBytes: 2 },
      { b: { cpu: null, memoryBytes: 400 } },
    );
    Queue.recordSample(
      dir,
      { at: now, busyCores: 0, cpuCount: 4, availableMemoryBytes: 1, totalMemoryBytes: 2 },
      {},
    );
    expect(Queue.read(dir)[0]!.memory).toBeUndefined();
    Queue.remove(dir, "b");
    const unread = Queue.readDoc(dir).history["vp run build"]![1];
    expect(unread).toMatchObject({ memoryBytes: 400 });
    expect(unread).not.toHaveProperty("cpu");
  });

  it.each(["__proto__", "constructor"])(
    "a command labelled %s is one more key: the history keeps its shape and its other commands",
    (label) => {
      const dir = tempDir();
      const sample = {
        at: 1,
        busyCores: 0,
        cpuCount: 4,
        availableMemoryBytes: 1,
        totalMemoryBytes: 2,
      };
      for (const [id, name, memoryBytes] of [
        ["other", "vp run build", 10],
        ["hostile", label, 20],
        ["after", "vp run lint", 30],
      ] as const) {
        Queue.enqueue(dir, { ...entry(id), label: name });
        Queue.tryStart(dir, id);
        Queue.recordSample(dir, sample, { [id]: { cpu: 1, memoryBytes } });
        Queue.remove(dir, id);
      }
      const doc = Queue.readDoc(dir);
      expect(Object.keys(doc.history)).toEqual(["vp run build", label, "vp run lint"]);
      expect(doc.history["vp run build"]?.map((run) => run.memoryBytes)).toEqual([10]);
      expect(Object.getOwnPropertyDescriptor(doc.history, label)?.value).toHaveLength(1);
      // Reading it back (plans, estimates, Linux's usual time) never throws.
      Queue.enqueue(dir, { ...entry("next"), label });
      expect(() => Queue.readPlan(dir)).not.toThrow();
      expect(Queue.usualMs(doc, { ...entry("x"), label }, "linux")).toBeNull();
    },
  );

  it("keeps only the last runs per command and ignores finished entries without samples", () => {
    const dir = tempDir();
    const GIB = 1024 ** 3;
    for (let i = 0; i < 8; i += 1) {
      if (i === 7) {
        // A thousand commands at most: the one run longest ago is forgotten first.
        const file = NodePath.join(dir, "queue.json");
        const doc = JSON.parse(NodeFS.readFileSync(file, "utf8"));
        const old = Array.from({ length: 1000 }, (_, n) => [
          `old ${n}`,
          [{ memoryBytes: 1, durationMs: 1 }],
        ]);
        doc.history = { ...Object.fromEntries(old), ...doc.history };
        NodeFS.writeFileSync(file, JSON.stringify(doc));
      }
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
    const { history } = Queue.readDoc(dir);
    expect((history["vp run build"] ?? []).map((r) => r.cpu)).toEqual([3, 4, 5, 6, 7]);
    expect(history["vp run lint"]).toBeUndefined();
    const commands = Object.keys(history);
    expect(commands).toHaveLength(1000);
    expect([commands[0], commands.at(-1)]).toEqual(["old 1", "vp run build"]);
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
      reason: "making sure the room lasts",
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

  it("stores the Mac's limits clamped to their ranges, and reads bad or missing ones as defaults", () => {
    const dir = tempDir();
    const file = NodePath.join(dir, "queue.json");
    const limits = () => {
      const { macMemoryFloorPercent, macCpuCeilingPercent, heavyOverLimitSeconds } =
        Queue.readDoc(dir);
      return [macMemoryFloorPercent, macCpuCeilingPercent, heavyOverLimitSeconds];
    };
    expect(limits()).toEqual([20, 70, 20]);
    const sizing = () => {
      const { lightJobMegabytes, unseenHeavyMegabytes, unseenMediumMegabytes } = Queue.readDoc(dir);
      const { historyCommands, headPatienceMinutes } = Queue.readDoc(dir);
      return [
        lightJobMegabytes,
        unseenHeavyMegabytes,
        unseenMediumMegabytes,
        historyCommands,
        headPatienceMinutes,
      ];
    };
    expect(sizing()).toEqual([512, 1536, 512, 1000, 5]);
    NodeFS.writeFileSync(
      file,
      JSON.stringify({
        macMemoryFloorPercent: 90,
        macCpuCeilingPercent: "70",
        heavyOverLimitSeconds: 45,
        lightJobMegabytes: 1,
        historyCommands: "50",
      }),
    );
    expect(limits()).toEqual([20, 70, 45]);
    expect(sizing()).toEqual([512, 1536, 512, 1000, 5]);
    Queue.setLimit(dir, "macMemoryFloorPercent", 2);
    Queue.setLimit(dir, "macCpuCeilingPercent", 85.7);
    Queue.setLimit(dir, "heavyOverLimitSeconds", 9_999);
    expect(limits()).toEqual([5, 85, 300]);
    Queue.setLimit(dir, "lightJobMegabytes", 256);
    Queue.setLimit(dir, "headPatienceMinutes", 999);
    expect(sizing()).toEqual([256, 1536, 512, 1000, 60]);
    // A medium job never needs more than a heavy one: rejected before writing, read as the heavy guess.
    expect(() => Queue.setLimits(dir, { unseenMediumMegabytes: 2048 })).toThrow(/heavy job/);
    expect(() => Queue.setLimits(dir, { unseenHeavyMegabytes: 256 })).toThrow(/heavy job/);
    Queue.setLimits(dir, { unseenHeavyMegabytes: 4096, unseenMediumMegabytes: 2048 });
    expect(sizing()).toEqual([256, 4096, 2048, 1000, 60]);
    const doc = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    NodeFS.writeFileSync(file, JSON.stringify({ ...doc, unseenHeavyMegabytes: 1024 }));
    expect(sizing()).toEqual([256, 1024, 1024, 1000, 60]);
  });

  it("knows which files the Linux copy has: not ignored ones, but node_modules a lockfile rebuilds", () => {
    const repo = NodeFS.realpathSync(tempDir());
    NodeChildProcess.spawnSync("git", ["init", "-q", repo]);
    NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), "dist/\n.venv/\nnode_modules/\n");
    NodeFS.mkdirSync(NodePath.join(repo, "web"));
    NodeFS.writeFileSync(NodePath.join(repo, "web", "pnpm-lock.yaml"), "");
    for (const [path, synced] of [
      ["src/a.test.ts", true],
      ["dist/cli.js", false],
      [".venv/bin/pytest", false],
      ["web/node_modules/.bin/vitest", true],
      ["node_modules/.bin/vitest", false],
      ["tools/node_modules/.bin/x", false],
    ] as const) {
      expect([path, Queue.syncedInCopy(NodePath.join(repo, path))]).toEqual([path, synced]);
    }
    // An answer is reused only briefly: a changed .gitignore shows within a minute.
    const script = NodePath.join(repo, "scripts", "go.sh");
    expect(Queue.syncedInCopy(script, 0)).toBe(true);
    NodeFS.appendFileSync(NodePath.join(repo, ".gitignore"), "scripts/\n");
    expect(Queue.syncedInCopy(script, 1_000)).toBe(true);
    expect(Queue.syncedInCopy(script, 61_000)).toBe(false);
  });

  it("sets several settings in one write, each clamped, ignoring unknown keys", () => {
    const dir = tempDir();
    Queue.setLimit(dir, "macCpuCeilingPercent", 80);
    const writes = vi.mocked(NodeFS.renameSync).mock.calls.length;
    Queue.setLimits(dir, {
      lightJobMegabytes: 256,
      headPatienceMinutes: 999,
      ...({ __proto__: 1, maxRunning: 9 } as object),
    });
    expect(vi.mocked(NodeFS.renameSync).mock.calls.length - writes).toBe(1);
    const doc = Queue.readDoc(dir);
    expect([doc.lightJobMegabytes, doc.headPatienceMinutes, doc.macCpuCeilingPercent]).toEqual([
      256, 60, 80,
    ]);
    expect(doc.maxRunning).toBe(Queue.readDoc(tempDir()).maxRunning);
  });

  it("forgets the oldest commands beyond the stored history size", () => {
    const dir = tempDir();
    const file = NodePath.join(dir, "queue.json");
    Queue.setLimit(dir, "historyCommands", 50);
    const doc = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    doc.history = Object.fromEntries(
      Array.from({ length: 80 }, (_, n) => [`old ${n}`, [{ memoryBytes: 1, durationMs: 1 }]]),
    );
    NodeFS.writeFileSync(file, JSON.stringify(doc));
    Queue.enqueue(dir, { ...entry("r"), label: "vp run build" });
    Queue.tryStart(dir, "r");
    Queue.recordSample(
      dir,
      {
        at: 1_800_000_000_000,
        busyCores: 0,
        cpuCount: 4,
        availableMemoryBytes: 1,
        totalMemoryBytes: 1,
      },
      { r: { cpu: 1, memoryBytes: 10 } },
    );
    Queue.remove(dir, "r");
    const commands = Object.keys(Queue.readDoc(dir).history);
    expect([commands.length, commands[0], commands.at(-1)]).toEqual([50, "old 31", "vp run build"]);
  });

  it("counts the Mac over its limits for routing only once readings stay there for the window", () => {
    const dir = tempDir();
    const reading = (at: number, busyCores: number) =>
      Queue.recordSample(
        dir,
        { at, busyCores, cpuCount: 10, availableMemoryBytes: 30, totalMemoryBytes: 32 },
        {},
      );
    const overLimit = () => Queue.readDoc(dir).sample?.overLimit;
    Queue.setLimit(dir, "macCpuCeilingPercent", 50);
    Queue.setLimit(dir, "heavyOverLimitSeconds", 10);
    reading(0, 1);
    // A 2-second spike moves nothing.
    reading(2_000, 9);
    reading(4_000, 1);
    expect(overLimit()).toBe(false);
    for (const at of [6_000, 8_000, 10_000, 12_000, 14_000]) reading(at, 6);
    expect(overLimit()).toBe(false);
    reading(16_000, 6);
    expect(overLimit()).toBe(true);
    reading(18_000, 1);
    reading(26_000, 1);
    expect(overLimit()).toBe(true);
    reading(28_000, 1);
    expect(overLimit()).toBe(false);
    expect(Queue.readDoc(dir).sample?.headroomSince).toBe(18_000);
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

  describe("one sample writer", () => {
    const reading = (at: number) => ({
      at,
      busyCores: 1,
      cpuCount: 10,
      availableMemoryBytes: 24 * 1024 ** 3,
      totalMemoryBytes: 32 * 1024 ** 3,
    });
    const published = (pid: number) => {
      const dir = tempDir();
      Queue.publishRunner(dir, {
        global: DEFAULT_PROJECT_CONFIG,
        machine: DEFAULT_MACHINE_CONFIG,
        projects: [],
        publisher: { pid, home: "/home", primary: true },
      });
      Queue.enqueue(dir, entry("a"));
      return dir;
    };
    /** A build from before sustained limits: it keeps `headroomSince` and drops the rest. */
    const oldWrite = (dir: string, at: number) => {
      const file = NodePath.join(dir, "queue.json");
      const doc = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      doc.sample = { ...reading(at), headroomSince: doc.sample?.headroomSince ?? at };
      NodeFS.writeFileSync(file, JSON.stringify(doc));
    };

    it("keeps the headroom window when an older build writes between readings", () => {
      const dir = published(process.pid);
      Queue.recordSample(dir, reading(1_000), {});
      for (let at = 2_000; at <= 9_000; at += 2_000) {
        oldWrite(dir, at);
        Queue.recordSample(dir, reading(at + 1_000), {});
      }
      // Six seconds of headroom held across both builds' writes: admission is steady again.
      expect(Queue.readDoc(dir).sample).toMatchObject({ at: 9_000, headroomSince: 1_000 });
    });

    it("lets only the publisher write each tick; another server writes once the sample is stale", () => {
      const other = process.ppid;
      const dir = published(process.pid);
      expect(Queue.recordSample(dir, reading(1_000), {})).toMatchObject({ primary: true });
      expect(Queue.recordSample(dir, reading(3_000), {}, other)).toBeNull();
      expect(Queue.readDoc(dir).sample?.at).toBe(1_000);
      // The primary stopped writing: the next reading past 5 s takes over, inside the 10 s gap.
      expect(Queue.recordSample(dir, reading(6_000), {}, other)).toMatchObject({ primary: false });
      expect(Queue.readDoc(dir).sample).toMatchObject({ at: 6_000, headroomSince: 1_000 });
    });

    it("lets every server write, and slow jobs down, while no publisher is alive", () => {
      const dir = published(deadPid());
      expect(Queue.recordSample(dir, reading(1_000), {}, process.ppid)).toMatchObject({
        primary: true,
      });
      expect(Queue.recordSample(dir, reading(3_000), {})).toMatchObject({ primary: true });
      expect(Queue.readDoc(dir).sample?.headroomSince).toBe(1_000);
    });
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
  /** A git checkout: work outside one stays on this Mac. */
  const checkout = (id: string) => {
    const root = NodePath.join(tempDir(), id);
    NodeFS.mkdirSync(NodePath.join(root, ".git"), { recursive: true });
    return root;
  };
  const test = (id: string, extra: Partial<HeavyQueueEntry> = {}) => ({
    ...entry(id),
    label: "vp test run",
    cwd: checkout(id),
    ...extra,
  });
  const queueWith = (runner: RunnerBlock, online: boolean | null = true) => {
    const dir = tempDir();
    Queue.publishRunner(dir, runner);
    if (online === true) Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat("") }, NOW);
    if (online === false) {
      // Failures closer than half a heartbeat are one outage: these are a heartbeat apart.
      const beat = DEFAULT_MACHINE_CONFIG.runnerHeartbeatSeconds * 1000;
      for (let i = DEFAULT_MACHINE_CONFIG.runnerOfflineAfterFailures; i > 0; i -= 1) {
        Queue.recordHealth(dir, { ok: false, error: "down" }, NOW - (i - 1) * beat);
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

  it("with the queue off, a pause left on never shows on a job waiting for Linux", () => {
    const dir = queueWith(
      block(config({ runnerWhere: "linux", runnerUnavailable: "wait" })),
      false,
    );
    Queue.setPaused(dir, true);
    Queue.setEnabled(dir, false);
    Queue.enqueue(dir, test("a"));
    const start = Queue.tryStart(dir, "a", NOW);
    expect(start).toMatchObject({ status: "waiting" });
    expect(start).not.toHaveProperty("paused");
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
    expect(Queue.readDoc(dir).events).toEqual([
      expect.objectContaining({
        kind: "deadline",
        dropped: false,
        job: expect.objectContaining({ id: "a" }),
      }),
    ]);
  });

  // Linux comes back long enough to take the job, which never reaches it, then goes again.
  const flap = (dir: string, at: number) => {
    const beat = DEFAULT_MACHINE_CONFIG.runnerHeartbeatSeconds * 1000;
    Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat("") }, NOW + at);
    expect(Queue.tryStart(dir, "a", NOW + at)).toMatchObject({
      status: "started",
      runner: "linux",
    });
    Queue.requeue(dir, "a", { linuxFailedAt: NOW + at + 1, linkFailures: 3 });
    Queue.recordHealth(dir, { ok: false, error: "down" }, NOW + at + 2);
    Queue.recordHealth(dir, { ok: false, error: "down" }, NOW + at + 2 + beat);
    return NOW + at + 2 + beat;
  };

  it.each([
    ["cancel", "canceled", "Linux is unavailable and nobody answered in time: canceled"],
    // The agent hears why its Linux job runs here.
    ["mac", "started", "Linux is unavailable and nobody answered: running here"],
    ["wait", "waiting", "Linux is unavailable: no answer, waiting for it"],
  ] as const)("a flapping link keeps the first deadline, then %s", (action, status, reason) => {
    const dir = queueWith(
      block(config({ runnerWhere: "linux", runnerAskMinutes: 2, runnerDeadlineAction: action })),
      false,
    );
    Queue.enqueue(dir, test("a"));
    Queue.tryStart(dir, "a", NOW);
    const deadline = { reason: "unavailable", deadlineAt: new Date(NOW + 120_000).toISOString() };
    const back = flap(dir, 30_000);
    expect(Queue.tryStart(dir, "a", back)).toMatchObject({
      status: "waiting",
      reason: "Linux is unavailable: waiting for your answer",
    });
    expect(Queue.read(dir)[0]!.ask).toEqual(deadline);
    const ended = Queue.tryStart(dir, "a", NOW + 120_000);
    expect(ended.status).toBe(status);
    if (reason !== undefined) expect(ended).toMatchObject({ reason });
    // The question was out all along: no second "Linux was unavailable" notice for it.
    expect(Queue.readDoc(dir).events.map((event) => event.kind)).not.toContain("linux-lost");
  });

  // A hand route lasts until the entry ends: an answer, or a move while Linux was up.
  it.each([
    ["answered Wait for Linux", false],
    ["moved to Linux by hand", true],
  ] as const)("a flapping link asks nobody again once %s", (_, online) => {
    const dir = queueWith(
      block(config({ runnerWhere: "linux", runnerUnavailable: "ask" })),
      online,
    );
    Queue.enqueue(dir, test("a"));
    if (!online) Queue.tryStart(dir, "a", NOW);
    expect(Queue.route(dir, "a", "linux")).toBe("ok");
    const back = flap(dir, 30_000);
    expect(Queue.tryStart(dir, "a", back)).toMatchObject({
      status: "waiting",
      reason: "waiting for Linux to come back",
    });
    expect(Queue.read(dir)[0]).not.toHaveProperty("ask");
    expect(Queue.readDoc(dir).events).toEqual([]);
  });

  // "When Linux is offline" decides a waiting job once, not again on every tick.
  it.each(["ask", "mac", "wait"] as const)("Linux offline, %s: applied once", (policy) => {
    const dir = queueWith(
      block(config({ runnerWhere: "linux", runnerUnavailable: policy })),
      false,
    );
    Queue.enqueue(dir, test("a"));
    const starts = [0, 1000, 2000].map((ms) => Queue.tryStart(dir, "a", NOW + ms).status);
    expect(starts).toEqual(Array(3).fill(policy === "mac" ? "started" : "waiting"));
    expect(Queue.read(dir)[0]!.ask?.deadlineAt).toBe(
      policy === "ask" ? new Date(NOW + 5 * 60_000).toISOString() : undefined,
    );
    expect(Queue.readDoc(dir).events.map((event) => event.kind)).toEqual(
      policy === "mac" ? ["displaced"] : [],
    );
  });

  // With the PC gone, the agent hears at once, even before Linux can confirm the run stopped.
  it.each([
    [false, "Linux couldn't run this: Linux dropped it mid-run"],
    [
      true,
      "Linux couldn't run this: Linux dropped it mid-run, and hasn't confirmed it stopped there",
    ],
  ] as const)(
    "Tell the agent ends a job Linux dropped (unconfirmed %s), without a nobody-answered notice",
    (unconfirmed, reason) => {
      const dir = queueWith(block(config({ runnerWhere: "linux", runnerDropped: "agent" })), false);
      Queue.enqueue(
        dir,
        test("a", {
          dropped: true,
          linuxFailedAt: NOW - 1000,
          ...(unconfirmed ? { unconfirmed } : {}),
        }),
      );
      expect(Queue.tryStart(dir, "a", NOW)).toEqual({ status: "canceled", reason });
      expect(Queue.read(dir)).toEqual([]);
      expect(Queue.readDoc(dir).events).toEqual([]);
    },
  );

  /** Linux's answers to a drain, and each stop it was asked for: `id:pgid`, `:group` when by pgid only. */
  const fakeLinux = () => {
    const stops: string[] = [];
    const linux = (
      answer: StopResult,
      pgidFile: Awaited<ReturnType<typeof readRemotePgid>> = null,
    ): { stop: typeof stopRemote; readPgid: typeof readRemotePgid } => ({
      stop: async (_machine, _env, id, pgid, pgidOnly) => {
        stops.push(`${id}:${pgid}${pgidOnly === true ? ":group" : ""}`);
        return answer;
      },
      readPgid: async () => pgidFile,
    });
    return { stops, linux };
  };

  // The job is gone, but its run may still live there: the worktree takes no Linux run meanwhile.
  it("a run canceled before Linux confirmed it stopped keeps its worktree off Linux until it does", async () => {
    const dir = queueWith(block(config({ runnerWhere: "linux", runnerDropped: "agent" })));
    const cwd = checkout("w");
    Queue.enqueue(dir, test("a", { cwd }));
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ status: "started", runner: "linux" });
    Queue.setProgress(dir, "a", { phase: "running", remote: { id: "w-1", pgid: 7 } });
    Queue.requeue(dir, "a", { dropped: true, unconfirmed: true, linuxFailedAt: NOW + 1 });
    const beat = DEFAULT_MACHINE_CONFIG.runnerHeartbeatSeconds * 1000;
    for (let i = 1; i <= DEFAULT_MACHINE_CONFIG.runnerOfflineAfterFailures; i += 1) {
      Queue.recordHealth(dir, { ok: false, error: "down" }, NOW + i * beat);
    }
    const away = NOW + 10 * beat;
    expect(Queue.tryStart(dir, "a", away)).toMatchObject({ status: "canceled" });
    expect(Queue.read(dir)).toEqual([]);

    const back = away + beat;
    Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat("") }, back);
    Queue.enqueue(dir, test("b", { cwd }));
    expect(Queue.tryStart(dir, "b", back)).toMatchObject({
      status: "waiting",
      reason: expect.stringContaining("hasn't confirmed an earlier run of this worktree stopped"),
    });

    // Each heartbeat that reaches Linux keeps stopping it, one process at a time.
    const { stops, linux } = fakeLinux();
    const [lost] = Queue.readDoc(dir).lostRuns;
    expect(Queue.claimLostRun(dir, lost!, Number.MAX_SAFE_INTEGER)).toBe(true);
    await drainLostRuns(dir, DEFAULT_MACHINE_CONFIG, {}, linux("stopped"));
    expect(stops).toEqual([]);
    Queue.settleLostRun(dir, lost!, false, Number.MAX_SAFE_INTEGER);
    await drainLostRuns(dir, DEFAULT_MACHINE_CONFIG, {}, linux("alive"));
    expect(Queue.tryStart(dir, "b", back)).toMatchObject({ status: "waiting" });
    await drainLostRuns(dir, DEFAULT_MACHINE_CONFIG, {}, linux("stopped"));
    expect(stops).toEqual(["w-1:7", "w-1:7"]);
    expect(Queue.readDoc(dir).lostRuns).toEqual([]);
    expect(Queue.tryStart(dir, "b", back)).toMatchObject({ status: "started", runner: "linux" });
  });

  it("logs a Linux-bound job that starts here, and the failure it then exits with", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux", runnerUnavailable: "mac" })), false);
    Queue.enqueue(dir, test("a"));
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ status: "started" });
    Queue.finish(dir, "a", 1, NOW);
    expect(Queue.read(dir)).toEqual([]);
    expect(Queue.readDoc(dir).events).toEqual([
      expect.objectContaining({ kind: "displaced", cause: "unavailable" }),
      expect.objectContaining({
        kind: "ended",
        code: 1,
        job: expect.objectContaining({ runner: "mac" }),
      }),
    ]);
  });

  it("answering sends the waiter where the user said and clears the question", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })), false);
    // An idle 10-core reading, so the worker count never follows the machine running the test.
    const idle = {
      at: NOW,
      busyCores: 0,
      cpuCount: 10,
      availableMemoryBytes: 9,
      totalMemoryBytes: 10,
    };
    Queue.recordSample(dir, idle, {});
    Queue.enqueue(dir, test("a"));
    Queue.tryStart(dir, "a", NOW);
    expect(Queue.route(dir, "a", "mac")).toBe("ok");
    expect(Queue.read(dir)[0]).toMatchObject({ route: "mac" });
    expect(Queue.read(dir)[0]).not.toHaveProperty("ask");
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ status: "started", workers: 9 });
    // The user's own move is no surprise.
    expect(Queue.readDoc(dir).events).toEqual([]);
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
    expect(Queue.readDoc(dir).lostRuns).toEqual([
      { key: expect.any(String), entryId: "a", cwd: again.cwd, remote: { id: "w-1", pgid: 7 } },
    ]);
    Queue.settleLostRun(dir, Queue.readDoc(dir).lostRuns[0]!, true);
    expect(Queue.read(dir)[0]).not.toHaveProperty("unconfirmed");
    expect(Queue.readDoc(dir).lostRuns).toEqual([]);
    expect(Queue.requeue(dir, "gone", {})).toBe(false);
    expect(Queue.readDoc(dir).events).toEqual([
      expect.objectContaining({ kind: "linux-lost", dropped: true, unconfirmed: true }),
    ]);
  });

  it("Move all routes the waiters that can run there, never running, Mac-only or unconfirmed ones", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    Queue.enqueue(dir, test("r"));
    expect(Queue.tryStart(dir, "r", NOW)).toMatchObject({ runner: "linux" });
    const waiters = [
      test("a"),
      test("b", { ask: { reason: "unavailable", deadlineAt: new Date(NOW).toISOString() } }),
      test("x", { label: "xcodebuild test" }),
      test("u", { unconfirmed: true }),
      // Asked for this Mac with `--runner mac`.
      test("m", { where: "mac" }),
      // Not on the Can run on Linux list: a hand route sends it all the same.
      test("n", { label: "vp run build" }),
    ];
    for (const waiter of waiters) Queue.enqueue(dir, waiter);
    const routes = () => Object.fromEntries(Queue.read(dir).map((e) => [e.id, e.route ?? null]));
    expect(Queue.routeAll(dir, "mac", NOW)).toEqual(["a", "b"]);
    expect(routes()).toEqual({ r: null, a: "mac", b: "mac", x: null, u: null, m: null, n: null });
    expect(Queue.read(dir).find((e) => e.id === "b")).not.toHaveProperty("ask");
    expect(Queue.routeAll(dir, "mac", NOW)).toEqual([]);
    expect(Queue.routeAll(dir, "linux", NOW)).toEqual(["a", "b", "n"]);
    expect(routes()).toEqual({
      r: null,
      a: "linux",
      b: "linux",
      x: null,
      u: null,
      m: null,
      n: "linux",
    });
    expect(Queue.read(dir).find((e) => e.id === "r")).not.toHaveProperty("requeue");
    // With the Runner off for the project, nothing can go to Linux, so nothing claims to.
    const off = queueWith(block(config({ runnerEnabled: false })));
    Queue.enqueue(off, test("a"));
    expect(Queue.routeAll(off, "linux", NOW)).toEqual([]);
    expect(Queue.route(off, "a", "linux")).toBe("not-allowed");
    expect(Queue.read(off)[0]).not.toHaveProperty("route");
  });

  it.each([
    ["offline", false],
    ["not checked yet", null],
  ] as const)(
    "Move all sends nothing to Linux while it is %s, and still brings waiters back",
    (_name, online) => {
      const dir = queueWith(block(config({ runnerWhere: "automatic" })), online);
      Queue.enqueue(dir, test("a"));
      Queue.enqueue(dir, test("b", { route: "linux" }));
      expect(Queue.routeAll(dir, "linux", NOW)).toEqual([]);
      expect(Queue.routeAll(dir, "mac", NOW)).toEqual(["b"]);
    },
  );

  // This Mac never shares the lost run's folder: only an answer for Linux waits for the confirmation.
  it.each([
    ["linux", "waiting"],
    ["mac", "started"],
  ] as const)("a drop's question answered for %s: %s", (runner, status) => {
    const dir = queueWith(block(config({ runnerWhere: "linux", runnerDropped: "ask" })), false);
    const ask = { reason: "dropped" as const, deadlineAt: new Date(NOW + 60_000).toISOString() };
    Queue.enqueue(
      dir,
      test("a", { dropped: true, linuxFailedAt: NOW - 1000, unconfirmed: true, ask }),
    );
    expect(Queue.route(dir, "a", runner)).toBe("ok");
    expect(Queue.read(dir)[0]).toMatchObject({ route: runner, unconfirmed: true });
    expect(Queue.read(dir)[0]).not.toHaveProperty("ask");
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ status });
  });

  // A rerun forced onto Linux takes the lost run's folder: the record stays, to stop that run by
  // its own process group only. Without one, the folder waits until Linux names it.
  it.each([
    [
      "reported its process group",
      { phase: "running" as const, remote: { id: "w-1", pgid: 7 } },
      7,
      "started",
      null,
      ["w-1:7:group"],
    ],
    [
      "never reported one, found in its pgid file",
      { phase: "syncing" as const },
      null,
      "waiting",
      42,
      ["?:42:group"],
    ],
    // Nothing new ran in the folder yet: the whole stop, by folder too, is still safe.
    [
      "never reported one, with no pgid file",
      { phase: "syncing" as const },
      null,
      "waiting",
      null,
      ["?:null"],
    ],
  ] as const)("a rerun forced onto Linux of a run that %s keeps its record", async (...row) => {
    const [, progress, pgid, status, pgidFile, stopped] = row;
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    const cwd = checkout("w");
    Queue.enqueue(dir, test("a", { cwd }));
    Queue.tryStart(dir, "a", NOW);
    Queue.setProgress(dir, "a", progress);
    Queue.requeue(dir, "a", { dropped: true, unconfirmed: true, linuxFailedAt: NOW - 1 });
    expect(Queue.route(dir, "a", "linux", true)).toBe("ok");
    expect(Queue.readDoc(dir).lostRuns).toEqual([
      expect.objectContaining({
        entryId: "a",
        pgidOnly: true,
        remote: expect.objectContaining({ pgid }),
      }),
    ]);
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ status });
    // Read while the record still holds the folder: stopped by its group, or wholly without one.
    const { stops, linux } = fakeLinux();
    const id = Queue.readDoc(dir).lostRuns[0]!.remote.id;
    await drainLostRuns(dir, DEFAULT_MACHINE_CONFIG, {}, linux("stopped", pgidFile));
    expect(stops).toEqual(stopped.map((stop) => stop.replace("?", id)));
    expect(Queue.readDoc(dir).lostRuns).toEqual([]);
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ status: "started", runner: "linux" });
  });

  // `remoto` names a folder outside a git checkout after its real path, as `pwd -P` gives it.
  it("a run lost outside a git checkout is recorded under remoto's name for its folder", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    const cwd = tempDir();
    Queue.enqueue(dir, test("a", { cwd, where: "linux" }));
    Queue.requeue(dir, "a", { dropped: true, unconfirmed: true, linuxFailedAt: NOW - 1 });
    const sha1 = (text: string) => NodeCrypto.createHash("sha1").update(text).digest("hex");
    expect(Queue.readDoc(dir).lostRuns).toEqual([
      expect.objectContaining({
        entryId: "a",
        remote: { id: runnerCopyId(NodeFS.realpathSync(cwd), sha1), pgid: null },
      }),
    ]);
  });

  // A stop that outlived its claim must not free the claim another process took since.
  it("a stop that ends unconfirmed frees only its own claim", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    Queue.enqueue(dir, test("a"));
    Queue.tryStart(dir, "a", NOW);
    Queue.setProgress(dir, "a", { phase: "running", remote: { id: "w-1", pgid: 7 } });
    Queue.requeue(dir, "a", { dropped: true, unconfirmed: true, linuxFailedAt: NOW - 1 });
    const [lost] = Queue.readDoc(dir).lostRuns;
    expect(Queue.claimLostRun(dir, lost!, NOW + 10, NOW)).toBe(true);
    expect(Queue.claimLostRun(dir, lost!, NOW + 50, NOW + 5)).toBe(false);
    expect(Queue.claimLostRun(dir, lost!, NOW + 50, NOW + 20)).toBe(true);
    Queue.settleLostRun(dir, lost!, false, NOW + 10);
    expect(Queue.readDoc(dir).lostRuns[0]!.stoppingUntil).toBe(NOW + 50);
    Queue.settleLostRun(dir, lost!, false, NOW + 50);
    expect(Queue.readDoc(dir).lostRuns[0]).not.toHaveProperty("stoppingUntil");
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
    const beat = DEFAULT_MACHINE_CONFIG.runnerHeartbeatSeconds * 1000;
    Queue.recordHealth(dir, { ok: false, error: "x" }, NOW - beat);
    expect(Queue.readDoc(dir).linux.online).toBeNull();
    // Two jobs losing the link together are one failure.
    Queue.recordHealth(dir, { ok: false, error: "x" }, NOW - beat + 500);
    expect(Queue.readDoc(dir).linux).toMatchObject({ online: null, failures: 1 });
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
    expect(Queue.modeFor(Queue.readDoc(dir), "/x")).toEqual({ enabled: true, runner: false });
  });

  it("reads a file from before Hybrid: overflow kept but unused, missing limits as defaults", () => {
    const dir = tempDir();
    const file = NodePath.join(dir, "queue.json");
    const {
      runnerLinuxMemoryFloorPercent: _f,
      runnerLinuxCpuCeilingPercent: _c,
      ...machine
    } = DEFAULT_MACHINE_CONFIG;
    const {
      runnerMacFirstAfter: _m,
      runnerLinuxEverything: _e,
      runnerBringBack: _b,
      ...older
    } = config({ runnerWhere: "automatic", runnerOverflow: 0 } as never);
    const old = older as unknown as RunnerProjectConfig;
    NodeFS.writeFileSync(
      file,
      JSON.stringify({
        runner: { ...block(old, [{ root: "/w", config: old }]), machine },
        linux: { online: true, failures: 0, checkedAt: NOW, okAt: NOW, load1: 9, cpuCount: 6 },
        sample: {
          at: NOW - 1000,
          busyCores: 1,
          cpuCount: 10,
          availableMemoryBytes: 20 * 1024 ** 3,
          totalMemoryBytes: 32 * 1024 ** 3,
          headroomSince: NOW - 60_000,
        },
      }),
    );
    const doc = Queue.readDoc(dir);
    expect(doc.runner?.machine).toEqual(DEFAULT_MACHINE_CONFIG);
    expect(doc).toMatchObject({ macMemoryFloorPercent: 20, heavyOverLimitSeconds: 20 });
    // A busy Linux in an old heartbeat is not over its limits until a new one says so.
    expect(doc.linux.overLimit).toBe(false);
    expect(Queue.configFor(doc, "/w/a").runnerWhere).toBe("automatic");
    // Settings added since read as their defaults, globally and per project.
    for (const cwd of ["/w/a", "/elsewhere"]) {
      expect(Queue.configFor(doc, cwd)).toMatchObject({
        runnerMacFirstAfter: 4,
        runnerLinuxEverything: false,
        runnerBringBack: false,
      });
    }
    Queue.enqueue(dir, test("a"));
    // Hybrid with room on the Mac keeps it here, however low the old overflow was.
    expect(Queue.tryStart(dir, "a", NOW)).toEqual({
      status: "started",
      workers: expect.any(Number),
    });
    expect(JSON.parse(NodeFS.readFileSync(file, "utf8")).runner.global.runnerOverflow).toBe(0);
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
      runner: block(config({ runnerAskMinutes: 3 }), [
        { root: main, config: config({ runnerAskMinutes: 9 }) },
      ]),
    };
    expect(Queue.configFor(doc, NodePath.join(worktree, "apps", "server")).runnerAskMinutes).toBe(
      9,
    );
  });

  it.each([
    {
      name: "Linux-bound with room starts on Linux",
      line: "vp test run",
      over: { runnerWhere: "linux" as const },
      expected: { runsOn: "linux", startsNow: true, linuxFull: false, reason: null },
    },
    {
      name: "a leading cd decides the folder and its settings",
      line: "cd {root} && vp test run",
      from: "/",
      over: { runnerWhere: "linux" as const },
      expected: { runsOn: "linux", startsNow: true },
    },
    {
      name: "git-driven work stays on this Mac",
      line: "vp test run --changed",
      over: { runnerWhere: "linux" as const },
      expected: { runsOn: "mac", reason: "Needs git, which the Linux copy doesn't have" },
    },
    {
      name: "Always on this Mac keeps a Linux-bound command here",
      line: "vp test run integration",
      over: { runnerWhere: "linux" as const, runnerMacOnly: ["integration"] },
      expected: { runsOn: "mac", reason: "Always on this Mac: integration" },
    },
    {
      name: "Runner off",
      line: "vp test run",
      over: { runnerEnabled: false },
      expected: { runsOn: "mac", reason: null },
    },
    {
      name: "Linux offline, policy wait: waits for Linux",
      line: "vp test run",
      online: false,
      over: { runnerWhere: "linux" as const, runnerUnavailable: "wait" as const },
      expected: {
        runsOn: "linux",
        startsNow: false,
        linuxFull: true,
        reason: "Linux is unavailable: waiting for it",
      },
    },
    {
      name: "Linux offline, policy mac: falls back here",
      line: "vp test run",
      online: false,
      over: { runnerWhere: "linux" as const, runnerUnavailable: "mac" as const },
      expected: { runsOn: "mac", reason: "Linux is unavailable: running here" },
    },
  ])("probe: $name, queuing nothing", ({ line, from, online, over, expected }) => {
    const dir = queueWith(block(config(over)), online ?? true);
    const root = checkout("probe");
    const probe = Queue.probe(dir, line.replace("{root}", root), from ?? root, NOW);
    expect(probe).toMatchObject(expected);
    expect(Queue.read(dir)).toEqual([]);
  });

  /** Starts each on Linux, one heartbeat apart, so the next one does not wait for a reading. */
  const startOnLinux = (dir: string, ids: ReadonlyArray<string>) =>
    ids.forEach((id, at) => {
      Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat("") }, NOW + at + 1);
      Queue.enqueue(dir, test(id));
      expect(Queue.tryStart(dir, id, NOW + at + 1)).toMatchObject({ runner: "linux" });
    });

  it("counts a waiter's place and running job on the machine it waits for", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    Queue.enqueue(dir, { ...test("m"), label: "vp run build" });
    expect(Queue.tryStart(dir, "m", NOW)).toMatchObject({ status: "started" });
    expect(Queue.tryStart(dir, "m", NOW)).not.toHaveProperty("runner");
    startOnLinux(dir, ["l1", "l2"]);
    Queue.enqueue(dir, { ...test("macWaiter"), label: "vp run build" });
    Queue.enqueue(dir, test("linuxWaiter"));
    expect(Queue.tryStart(dir, "linuxWaiter", NOW + 3)).toMatchObject({
      status: "waiting",
      position: 1,
      running: { id: "l1" },
      runner: "linux",
      reason: "waiting for Linux: all 2 Linux slots are busy",
    });
    expect(Queue.tryStart(dir, "macWaiter", NOW + 3)).toMatchObject({
      status: "waiting",
      position: 1,
      running: { id: "m" },
      runner: "mac",
    });
  });

  it("learns each machine's usual cost only from its own runs", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    const peak = { cpu: 0.1, memoryBytes: 50 };
    const sample = {
      at: NOW,
      busyCores: 0,
      cpuCount: 4,
      availableMemoryBytes: 1,
      totalMemoryBytes: 2,
    };
    // Linux: the local tree is only the wrapper, so its usage is never kept.
    Queue.enqueue(dir, test("l"));
    expect(Queue.tryStart(dir, "l", NOW)).toMatchObject({ runner: "linux" });
    Queue.setProgress(dir, "l", { phase: "running" });
    Queue.recordSample(dir, sample, { l: peak });
    expect(Queue.read(dir)[0]).not.toHaveProperty("peakMemory");
    Queue.finish(dir, "l", 0, NOW + 60_000);
    // One that never ran there, only synced, teaches nothing.
    Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat("") }, NOW + 60_001);
    Queue.enqueue(dir, test("synced"));
    expect(Queue.tryStart(dir, "synced", NOW + 60_001)).toMatchObject({ runner: "linux" });
    Queue.setProgress(dir, "synced", { phase: "syncing" });
    Queue.finish(dir, "synced", 75, NOW + 70_000);
    // The Mac: the same command run here keeps its usage under the Mac's history.
    Queue.enqueue(dir, test("m", { route: "mac" }));
    expect(Queue.tryStart(dir, "m", NOW + 70_000)).toEqual({ status: "started", workers: 3 });
    Queue.recordSample(dir, sample, { m: { cpu: 3, memoryBytes: 900 } });
    Queue.finish(dir, "m", 0, NOW + 100_000);
    const doc = Queue.readDoc(dir);
    expect(doc.history["vp test run"]).toEqual([{ cpu: 3, memoryBytes: 900, durationMs: 30_000 }]);
    expect(doc.linuxHistory["vp test run"]).toEqual([{ durationMs: 60_000 }]);
    expect(Queue.usualMs(doc, test("x"), "linux")).toBe(60_000);
    expect(Queue.usualMs(doc, test("x"), "mac")).toBe(30_000);
    expect(Queue.usualMs(doc, { label: "vp run lint" }, "linux")).toBeNull();
  });

  it("probe: Linux with every slot busy is full and the command would wait", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    startOnLinux(dir, ["a", "b"]);
    expect(Queue.probe(dir, "vp test run", checkout("c"), NOW + 3)).toMatchObject({
      runsOn: "linux",
      startsNow: false,
      linuxFull: true,
      reason: "waiting for Linux: all 2 Linux slots are busy",
    });
  });

  it("probe: a Linux waiter ahead counts toward Linux being full", () => {
    const dir = queueWith(block(config({ runnerWhere: "linux" })));
    Queue.enqueue(dir, test("a"));
    expect(Queue.tryStart(dir, "a", NOW)).toMatchObject({ runner: "linux" });
    Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat("") }, NOW + 1);
    Queue.enqueue(dir, { ...test("b"), priority: "normal" });
    expect(Queue.probe(dir, "vp test run", checkout("c"), NOW + 2)).toMatchObject({
      runsOn: "linux",
      startsNow: false,
      linuxFull: true,
    });
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
        expect(answer.hookSpecificOutput.updatedInput.command).toContain("-c 'remoto vp test run'");
      }
    });

    it("follows the project of the call's folder", () => {
      const dir = queueWith(
        block(config({ runnerEnabled: false }), [{ root: "/w/on", config: config() }]),
      );
      Queue.setEnabled(dir, false);
      expect(Queue.answerBashCall(dir, call("vp test run", "/w/on/src"), PREFIX)).not.toBeNull();
      expect(Queue.answerBashCall(dir, call("vp test run", "/w/off"), PREFIX)).toBeNull();
      // A leading `cd` names the folder the command runs in, so its project decides.
      expect(
        Queue.answerBashCall(dir, call("cd ../on && vp test run", "/w/off"), PREFIX),
      ).not.toBeNull();
      expect(
        Queue.answerBashCall(dir, call("cd /w/off && vp test run", "/w/on"), PREFIX),
      ).toBeNull();
    });

    it("queues a commit only where a commit hook runs, judged in the folder its cd names", () => {
      const dir = queueWith(block(config({ runnerEnabled: false })));
      const parent = tempDir();
      const root = NodePath.join(parent, "repo");
      NodeFS.mkdirSync(root);
      NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: root });
      const commit = call("cd repo && git commit -m 'fix: x'", parent);
      expect(Queue.answerBashCall(dir, commit, PREFIX)).toBeNull();
      expect(Queue.probe(dir, commit.tool_input.command, parent, NOW)).toEqual({
        runsOn: "direct",
        reason: "No commit hook in this repository: runs directly",
        startsNow: true,
        linuxFull: false,
      });
      NodeFS.writeFileSync(NodePath.join(root, ".git/hooks/pre-commit"), "exit 0", { mode: 0o755 });
      expect(Queue.answerBashCall(dir, commit, PREFIX)).not.toBeNull();
      // Its own slot: it starts beside a running job, ahead of an agent's waiting build.
      Queue.enqueue(dir, test("busy"));
      expect(Queue.tryStart(dir, "busy", NOW)).toMatchObject({ status: "started" });
      Queue.enqueue(dir, { ...test("build"), priority: "low" });
      expect(Queue.probe(dir, commit.tool_input.command, parent, NOW)).toMatchObject({
        runsOn: "mac",
        startsNow: true,
      });
      expect(Queue.read(dir).map((e) => e.id)).toEqual(["busy", "build"]);
    });
  });
});
