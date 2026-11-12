// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as HeavyQueue from "./HeavyQueue.ts";
import * as Queue from "./queueFile.ts";

const holder: HeavyQueueEntry = {
  id: "holder",
  pid: process.pid,
  threadId: null,
  label: "tests",
  cwd: "/",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
};

/** A queue directory with `holder` already running; removed when the test ends. */
const withQueue = <A, E>(
  body: (dir: string, queue: HeavyQueue.HeavyQueue["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-svc-"))),
    (dir) =>
      Effect.gen(function* () {
        Queue.enqueue(dir, holder);
        Queue.tryStart(dir, holder.id);
        const queue = yield* HeavyQueue.HeavyQueue;
        return yield* body(dir, queue);
      }).pipe(
        Effect.provide(
          // A settings file inside the temp queue dir: the user's own Claude settings stay untouched.
          HeavyQueue.layer(dir, NodePath.join(dir, "claude", "settings.json")).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const priorities = (pids: ReadonlyArray<number>) =>
  NodeChildProcess.execFileSync("/bin/ps", ["-o", "pri=", "-p", pids.join(",")], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)
    .map(Number);

describe("HeavyQueue", () => {
  it("finds a job's whole process tree from ps rows", () => {
    const ps = "  1     0\n 10     1\n 11    10\n 12    11\n 13    10\n 20     1\n bad row\n";
    expect(HeavyQueue.treePids(ps, 10)).toEqual([10, 11, 13, 12]);
    expect(HeavyQueue.treePids(ps, 99)).toEqual([99]);
  });

  it.effect("lowers and raises every process of a running job, and high releases a waiter", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        // A job whose command started a child: both must move.
        const parent = NodeChildProcess.spawn(process.execPath, [
          "-e",
          `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1e3)"],{stdio:"inherit"});console.log(c.pid);setInterval(()=>{},1e3)`,
        ]);
        const childPid = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) =>
              parent.stdout!.once("data", (d) => resolve(Number(d))),
            ),
        );
        try {
          Queue.remove(dir, holder.id);
          Queue.enqueue(dir, { ...holder, id: "job", pid: parent.pid! });
          Queue.tryStart(dir, "job");
          Queue.enqueue(dir, { ...holder, id: "waiter", priority: "low" });
          yield* queue.setPriority("job", "low");
          const darwin = NodeOS.platform() === "darwin"; // oxlint-disable-line t3code/no-global-process-runtime -- taskpolicy exists only on the real macOS host.
          if (darwin) expect(priorities([parent.pid!, childPid])).toEqual([4, 4]);
          yield* queue.setPriority("job", "high");
          if (darwin)
            expect(priorities([parent.pid!, childPid]).every((pri) => pri > 4)).toBe(true);
          expect(Queue.read(dir).find((e) => e.id === "job")).toMatchObject({ priority: "high" });
          yield* queue.setPriority("waiter", "high");
          expect(Queue.read(dir).find((e) => e.id === "waiter")).toMatchObject({ forced: true });
          const missing = yield* Effect.flip(queue.setPriority("gone", "high"));
          expect(missing.reason).toBe("not-found");
        } finally {
          process.kill(childPid, "SIGKILL");
          parent.kill("SIGKILL");
        }
      }),
    ),
  );

  it.effect(
    "installs the Claude hook in the given settings and reports it, and keeps idle minutes",
    () =>
      withQueue((dir, queue) =>
        Effect.gen(function* () {
          expect(yield* queue.state).toMatchObject({
            claudeHookInstalled: false,
            deviceIdleMinutes: 20,
          });
          yield* queue.setClaudeHook(true);
          yield* queue.setDeviceIdleMinutes(45);
          expect(yield* queue.state).toMatchObject({
            claudeHookInstalled: true,
            deviceIdleMinutes: 45,
          });
          const written = NodeFS.readFileSync(
            NodePath.join(dir, "claude", "settings.json"),
            "utf8",
          );
          // The settings name the sh pre-filter, which hands possible heavy calls to this T3.
          expect(written).toContain(`"/bin/sh '${dir}/t3-heavy-hook.sh'"`);
          expect(NodeFS.readFileSync(NodePath.join(dir, "t3-heavy-hook.sh"), "utf8")).toContain(
            `heavy hook --queue-dir '${dir}'`,
          );
          yield* queue.setClaudeHook(false);
          yield* queue.setDeviceIdleMinutes(-3);
          expect(yield* queue.state).toMatchObject({
            claudeHookInstalled: false,
            deviceIdleMinutes: 0,
          });
          NodeFS.writeFileSync(NodePath.join(dir, "claude", "settings.json"), "{ broken");
          expect((yield* Effect.flip(queue.setClaudeHook(true))).reason).toBe("unavailable");
        }),
      ),
  );

  it.effect("the Bash hook queues heavy calls only while the queue is on", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const command = yield* queue.command;
        const hook = HeavyQueue.bashHook(command.slice(0, -" --".length), dir);
        const call = { tool_name: "Bash", tool_input: { command: "vp run build" } };
        expect(JSON.stringify(hook(call))).toContain(`--queue-dir '${dir}' --name 'vp run build'`);
        Queue.setEnabled(dir, false);
        expect(hook(call)).toBeNull();
      }),
    ),
  );

  it.effect("withSlot waits behind a running entry, runs once it is free, then leaves", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const ran = yield* Deferred.make<string>();
        const fiber = yield* Effect.forkChild(
          queue.withSlot("Open iPhone", "thread-1", Deferred.succeed(ran, "ran")),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        expect(Queue.read(dir).map((e) => e.label)).toEqual(["tests", "Open iPhone"]);
        expect(Queue.read(dir)[1]).toMatchObject({ threadId: "thread-1", pid: process.pid });
        expect(yield* Deferred.isDone(ran)).toBe(false);
        Queue.remove(dir, holder.id);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
        expect(yield* Deferred.await(ran)).toBe("ran");
        expect(Queue.read(dir)).toEqual([]);
      }),
    ),
  );

  it.effect(
    "switched off, withSlot runs at once beside the running entry and is shown running",
    () =>
      withQueue((dir, queue) =>
        Effect.gen(function* () {
          Queue.enqueue(dir, { ...holder, id: "waiter" });
          yield* queue.setPaused(true);
          yield* queue.setEnabled(false);
          const seen = yield* queue.withSlot(
            "Open iPhone",
            "thread-1",
            Effect.sync(() => Queue.read(dir).find((e) => e.label === "Open iPhone")),
          );
          expect(seen).toMatchObject({ server: true, threadId: "thread-1" });
          expect(seen?.startedAt).not.toBeNull();
          expect(yield* queue.state).toMatchObject({
            enabled: false,
            paused: true,
            reasons: {},
            entries: [{ id: holder.id }, { id: "waiter", startedAt: null }],
          });
          yield* queue.setEnabled(true);
          expect(yield* queue.state).toMatchObject({
            enabled: true,
            reasons: { waiter: "paused" },
          });
        }),
      ),
  );

  it.effect("withSlot frees its place when interrupted, waiting or running", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const waiting = yield* Effect.forkChild(queue.withSlot("a", null, Effect.void));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        expect(Queue.read(dir)).toHaveLength(2);
        yield* Fiber.interrupt(waiting);
        expect(Queue.read(dir).map((e) => e.id)).toEqual([holder.id]);

        const started = yield* Deferred.make<void>();
        const running = yield* Effect.forkChild(
          queue.withSlot(
            "b",
            null,
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );
        yield* Effect.yieldNow;
        Queue.remove(dir, holder.id);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(started);
        expect(Queue.read(dir)[0]).toMatchObject({ label: "b" });
        yield* Fiber.interrupt(running);
        expect(Queue.read(dir)).toEqual([]);
      }),
    ),
  );

  it.effect("withSlot fails when the user removes the waiting entry", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(queue.withSlot("a", null, Effect.void));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* queue.cancel(Queue.read(dir)[1]!.id);
        yield* TestClock.adjust("1 second");
        const error = yield* Effect.flip(Fiber.join(fiber));
        expect(error).toMatchObject({ _tag: "HeavyQueueError", reason: "not-found" });
      }),
    ),
  );

  it.effect("promote and cancel fail for the running entry and for unknown ids", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        Queue.enqueue(dir, { ...holder, id: "x" });
        Queue.enqueue(dir, { ...holder, id: "y" });
        yield* queue.promote("y");
        expect((yield* queue.state).entries.map((e) => e.id)).toEqual([holder.id, "y", "x"]);
        expect((yield* Effect.flip(queue.promote(holder.id))).reason).toBe("running");
        expect((yield* Effect.flip(queue.cancel(holder.id))).reason).toBe("running");
        expect((yield* Effect.flip(queue.cancel("zzz"))).reason).toBe("not-found");
        yield* queue.cancel("x");
        expect((yield* queue.state).entries.map((e) => e.id)).toEqual([holder.id, "y"]);
      }),
    ),
  );

  it.effect("state gives a waiter its command's usual cost only when it has history", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const job = (id: string): HeavyQueueEntry => ({ ...holder, id, label: "vp run build" });
        Queue.enqueue(dir, job("old"));
        Queue.enqueue(dir, job("new"));
        Queue.enqueue(dir, { ...job("other"), label: "unseen command" });
        expect((yield* queue.state).estimates).toEqual({});
        Queue.remove(dir, "holder");
        Queue.tryStart(dir, "old");
        Queue.recordSample(
          dir,
          { at: 1, busyCores: 1, cpuCount: 8, availableMemoryBytes: 5, totalMemoryBytes: 10 },
          { old: { cpu: 3, memoryBytes: 1000 } },
        );
        Queue.remove(dir, "old");
        const { estimates } = yield* queue.state;
        expect(estimates?.["new"]).toMatchObject({ cpu: 3, memoryBytes: 1000 });
        expect(estimates?.["other"]).toBeUndefined();
        expect((yield* queue.state).room).toBe(true);
        Queue.recordSample(
          dir,
          { at: 2, busyCores: 8, cpuCount: 8, availableMemoryBytes: 5, totalMemoryBytes: 10 },
          {},
        );
        expect(yield* queue.state).toMatchObject({ room: false, machine: { busyCores: 8 } });
      }),
    ),
  );

  it.effect("moves, pauses and sets priority rules through the shared file", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        Queue.enqueue(dir, { ...holder, id: "x" });
        Queue.enqueue(dir, { ...holder, id: "y" });
        yield* queue.move("y", "x");
        yield* queue.setPaused(true);
        yield* queue.setRule("/proj", "last");
        expect(yield* queue.state).toMatchObject({
          entries: [{ id: holder.id }, { id: "y", note: "Moved by the user" }, { id: "x" }],
          paused: true,
          rules: [{ root: "/proj", priority: "last" }],
          maxRunning: 3,
          room: false,
        });
        yield* queue.setMaxRunning(1);
        expect((yield* queue.state).reasons["y"]).toBe("paused");
        expect((yield* queue.state).maxRunning).toBe(1);
        expect((yield* Effect.flip(queue.move("zzz", null))).reason).toBe("not-found");
        yield* queue.setRule("/proj", null);
        expect((yield* queue.state).rules).toEqual([]);
      }),
    ),
  );

  it.effect("streams the state at once and again only when it changes", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(queue.stream.pipe(Stream.take(2), Stream.runCollect));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("2 seconds");
        yield* TestClock.adjust("2 seconds");
        Queue.enqueue(dir, { ...holder, id: "x" });
        yield* TestClock.adjust("2 seconds");
        const states = yield* Fiber.join(fiber);
        expect(states.map((s) => s.entries.length)).toEqual([1, 2]);
      }),
    ),
  );

  it.effect("streams a change made here without waiting for the poll", () =>
    withQueue((_dir, queue) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(queue.stream.pipe(Stream.take(2), Stream.runCollect));
        yield* TestClock.adjust("2 seconds");
        yield* queue.setEnabled(false);
        const states = yield* Fiber.join(fiber);
        expect(states.map((s) => s.enabled)).toEqual([true, false]);
      }),
    ),
  );

  it.effect("hands agents a quoted command that runs the CLI against this queue", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const command = yield* queue.command;
        expect(command).toContain(` heavy --queue-dir '${dir}' --`);
        expect(command.startsWith(`ELECTRON_RUN_AS_NODE=1 '${process.execPath}'`)).toBe(true);
      }),
    ),
  );
});
