// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry } from "@t3tools/contracts";

import * as Queue from "./queueFile.ts";

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
    expect(Queue.tryStart(dir, "a")).toEqual({ status: "started" });
    expect(Queue.tryStart(dir, "a")).toEqual({ status: "started" });
    expect(Queue.tryStart(dir, "b")).toMatchObject({ status: "waiting", position: 1 });
    const second = Queue.tryStart(dir, "c");
    expect(second).toMatchObject({ status: "waiting", position: 2, running: { id: "a" } });
    expect(Queue.read(dir).filter((e) => e.startedAt !== null)).toHaveLength(1);
    Queue.remove(dir, "a");
    expect(Queue.tryStart(dir, "c")).toMatchObject({ status: "waiting", position: 2 });
    expect(Queue.tryStart(dir, "b")).toEqual({ status: "started" });
    expect(Queue.tryStart(dir, "gone")).toEqual({ status: "removed" });
  });

  it("prunes entries whose process died, so the next waiter starts", () => {
    const dir = tempDir();
    Queue.enqueue(dir, entry("dead", deadPid()));
    Queue.enqueue(dir, entry("live"));
    expect(Queue.read(dir).map((e) => e.id)).toEqual(["live"]);
    expect(Queue.tryStart(dir, "live")).toEqual({ status: "started" });
    expect(Queue.isAlive(process.pid)).toBe(true);
    expect(Queue.isAlive(deadPid()!)).toBe(false);
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
});
