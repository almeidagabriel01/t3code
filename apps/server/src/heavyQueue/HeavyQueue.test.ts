// @effect-diagnostics nodeBuiltinImport:off globalDate:off
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
      }).pipe(Effect.provide(HeavyQueue.layer(dir).pipe(Layer.provide(NodeServices.layer)))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

describe("HeavyQueue", () => {
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
