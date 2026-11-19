// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as HeavyQueue from "./HeavyQueue.ts";
import * as Queue from "./queueFile.ts";
import { recordRouteFault } from "./routeMemory.ts";
import { DEFAULT_MACHINE_CONFIG, DEFAULT_PROJECT_CONFIG, parseHeartbeat } from "./runner.ts";

const holder: HeavyQueueEntry = {
  id: "holder",
  pid: process.pid,
  threadId: null,
  label: "tests",
  cwd: "/",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
};

const GIB = 1024 ** 3;
/** After any real clock this suite runs on, so `holder`'s real start is long settled. */
const LATER = Date.parse("2030-01-01T00:00:00.000Z");
const ago = (ms: number) => new Date(LATER - ms).toISOString();
/** The live Mac when the queue ran one at a time: 28% of 16 GB free, CPU quiet. */
const MAC_28 = {
  busyCores: 1,
  cpuCount: 10,
  availableMemoryBytes: 0.28 * 16 * GIB,
  totalMemoryBytes: 16 * GIB,
  pressureLevel: 1,
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
          const qos = () => Queue.read(dir).find((e) => e.id === "job")?.qos;
          yield* queue.setPriority("job", "low");
          const darwin = NodeOS.platform() === "darwin"; // oxlint-disable-line t3code/no-global-process-runtime -- taskpolicy exists only on the real macOS host.
          // Background is 4, and a busy machine can show a running background thread lower still.
          if (darwin)
            expect(priorities([parent.pid!, childPid]).every((pri) => pri <= 4)).toBe(true);
          expect(qos()).toBe(darwin ? "background" : undefined);
          yield* queue.setPriority("job", "high");
          if (darwin)
            expect(priorities([parent.pid!, childPid]).every((pri) => pri > 4)).toBe(true);
          expect(qos()).toBe(darwin ? "normal" : undefined);
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

  it.effect("a T3 running from a checkout leaves the installed hook and settings alone", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-src-"))),
      (dir) => {
        const checkout = NodePath.join(dir, "checkout");
        NodeFS.mkdirSync(NodePath.join(checkout, ".git"), { recursive: true });
        const settings = NodePath.join(dir, "claude", "settings.json");
        NodeFS.mkdirSync(NodePath.dirname(settings));
        const installed = JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: `/bin/sh '${dir}/t3-heavy-hook.sh'` }],
              },
            ],
          },
        });
        NodeFS.writeFileSync(settings, installed);
        return Effect.gen(function* () {
          const queue = yield* HeavyQueue.HeavyQueue;
          for (const install of [true, false]) {
            expect((yield* Effect.flip(queue.setClaudeHook(install))).reason).toBe("not-allowed");
          }
          expect(NodeFS.readFileSync(settings, "utf8")).toBe(installed);
          // The startup refresh would point the installed hook at this checkout.
          expect(NodeFS.existsSync(NodePath.join(dir, "t3-heavy-hook.sh"))).toBe(false);
        }).pipe(
          Effect.provide(HeavyQueue.layer(dir, settings).pipe(Layer.provide(NodeServices.layer))),
          Effect.provideService(HostProcess.Arguments, [
            process.execPath,
            NodePath.join(checkout, "apps", "server", "src", "bin.ts"),
          ]),
        );
      },
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    ),
  );

  it.effect("the Bash hook takes heavy calls while the queue or the Runner is on", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const command = yield* queue.command;
        const hook = HeavyQueue.bashHook(command.slice(0, -" --".length), dir);
        const call = { tool_name: "Bash", tool_input: { command: "vp run build" } };
        expect(JSON.stringify(hook(call))).toContain(`--queue-dir '${dir}' --name 'vp run build'`);
        Queue.setEnabled(dir, false);
        expect(hook(call)).toBeNull();
        Queue.publishRunner(dir, {
          global: { ...DEFAULT_PROJECT_CONFIG, runnerEnabled: true },
          machine: DEFAULT_MACHINE_CONFIG,
          projects: [],
          publisher: { pid: process.pid, home: dir, primary: true },
        });
        expect(JSON.stringify(hook(call))).toContain("--name 'vp run build'");
        // Builds never leave this Mac, and asking queues nothing.
        const before = Queue.read(dir);
        expect(yield* queue.probe("vp run build", dir)).toMatchObject({ runsOn: "mac" });
        expect(Queue.read(dir)).toEqual(before);
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

  it.effect("state shows usage for this Mac's jobs only, never a Linux job's wrapper", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const checkout = NodePath.join(dir, "repo");
        NodeFS.mkdirSync(NodePath.join(checkout, ".git"), { recursive: true });
        const job = (id: string, cwd = checkout): HeavyQueueEntry => ({
          ...holder,
          id,
          label: "vp test run",
          cwd,
        });
        Queue.remove(dir, "holder");
        // One Mac run of the command teaches its usual cost.
        Queue.enqueue(dir, job("past", "/"));
        Queue.tryStart(dir, "past");
        Queue.recordSample(
          dir,
          { at: 1, busyCores: 1, cpuCount: 8, availableMemoryBytes: 5, totalMemoryBytes: 10 },
          { past: { cpu: 3, memoryBytes: 1000 } },
        );
        Queue.remove(dir, "past");
        Queue.publishRunner(dir, {
          global: { ...DEFAULT_PROJECT_CONFIG, runnerEnabled: true, runnerWhere: "linux" },
          machine: DEFAULT_MACHINE_CONFIG,
          projects: [],
          publisher: { pid: process.pid, home: dir, primary: true },
        });
        Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat("") });
        Queue.enqueue(dir, job("linuxRun"));
        expect(Queue.tryStart(dir, "linuxRun")).toMatchObject({ runner: "linux" });
        // As a version that sampled the wrapper left it in the file.
        const file = NodePath.join(dir, "queue.json");
        const doc = JSON.parse(NodeFS.readFileSync(file, "utf8"));
        doc.entries[0] = { ...doc.entries[0], cpu: 0.1, memory: 9, peakCpu: 0.2, peakMemory: 9 };
        NodeFS.writeFileSync(file, JSON.stringify(doc));
        Queue.enqueue(dir, job("macWaiter", "/"));
        Queue.enqueue(dir, job("linuxWaiter"));
        const state = yield* queue.state;
        expect(state.routes).toMatchObject({ macWaiter: "mac", linuxWaiter: "linux" });
        expect(Object.keys(state.estimates ?? {})).toEqual(["macWaiter"]);
        const running = state.entries.find((entry) => entry.id === "linuxRun");
        for (const key of ["cpu", "memory", "peakCpu", "peakMemory"]) {
          expect(running).not.toHaveProperty(key);
        }
        // Move all to this Mac takes the Linux waiter and leaves the running job.
        expect(yield* queue.routeAll("mac")).toEqual(["linuxWaiter"]);
        expect((yield* queue.state).routes).toMatchObject({ linuxWaiter: "mac" });
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
        // Nothing is held back (the head may start), yet the summary must not claim room.
        expect(yield* queue.state).toMatchObject({
          room: false,
          hold: "cpu",
          machine: { busyCores: 8, pressureLevel: null },
        });
        Queue.recordSample(
          dir,
          {
            at: 3,
            busyCores: 1,
            cpuCount: 8,
            availableMemoryBytes: 5,
            totalMemoryBytes: 10,
            pressureLevel: 2,
            swapInBytesPerSecond: 40,
          },
          {},
        );
        expect(yield* queue.state).toMatchObject({
          hold: "pressure",
          machine: { pressureLevel: 2, swapInBytesPerSecond: 40 },
        });
      }),
    ),
  );

  it.effect("starts jobs side by side on a roomy 16 GB Mac, and one at a time under pressure", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(LATER);
        Queue.remove(dir, holder.id);
        for (const id of ["a", "b", "c", "d"]) {
          Queue.enqueue(dir, {
            ...holder,
            id,
            label: "vp test run src/a.test.ts",
            createdAt: ago(1000),
          });
        }
        // Headroom has held for eight seconds of unbroken readings: 28% of 16 GB free, CPU quiet.
        Queue.recordSample(dir, { ...MAC_28, at: LATER - 8_000 }, {});
        const started = () => Queue.read(dir).flatMap((e) => (e.startedAt === null ? [] : [e.id]));
        const step = (at: number, sample: Partial<typeof MAC_28> = {}) => {
          // Readings come every few seconds; a longer gap would restart the headroom window.
          Queue.recordSample(dir, { ...MAC_28, ...sample, at: at - 8_000 }, {});
          Queue.recordSample(dir, { ...MAC_28, ...sample, at }, {});
          for (const id of ["a", "b", "c", "d"]) Queue.tryStart(dir, id, at);
        };
        step(LATER);
        expect(started()).toEqual(["a"]);
        // One start per settle window, each judged on a fresh reading.
        step(LATER + 16_000);
        step(LATER + 32_000);
        expect(started()).toEqual(["a", "b", "c"]);
        yield* TestClock.setTime(LATER + 32_000);
        expect((yield* queue.state).reasons).toEqual({ d: "all 3 slots busy" });

        Queue.remove(dir, "b");
        Queue.remove(dir, "c");
        step(LATER + 48_000, { pressureLevel: 2 });
        expect(started()).toEqual(["a"]);
        yield* TestClock.setTime(LATER + 48_000);
        expect((yield* queue.state).reasons).toEqual({ d: "memory pressure high" });
        Queue.remove(dir, "a");
        step(LATER + 49_000, { pressureLevel: 2 });
        expect(started()).toEqual(["d"]);
      }),
    ),
  );

  it.effect(
    "a head that does not fit lets a small job pass, then gets its turn after its patience",
    () =>
      withQueue((dir, queue) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(LATER);
          const job = (id: string, label: string): HeavyQueueEntry => ({
            ...holder,
            id,
            label,
            createdAt: ago(1000),
          });
          Queue.enqueue(dir, job("big", "vp run build"));
          Queue.enqueue(dir, job("small", "vp run typecheck"));
          Queue.enqueue(dir, job("small2", "vp run lint"));
          // The holder has run for a minute, so its usage is in the reading.
          const file = NodePath.join(dir, "queue.json");
          const doc = JSON.parse(NodeFS.readFileSync(file, "utf8"));
          NodeFS.writeFileSync(
            file,
            JSON.stringify({
              ...doc,
              lastStartAt: LATER - 60_000,
              entries: doc.entries.map((e: HeavyQueueEntry) =>
                e.id === holder.id ? { ...e, startedAt: ago(60_000) } : e,
              ),
            }),
          );
          // 28% of 16 GB free: a never-seen build (1.5 GB) would cut into the 20% kept spare, a typecheck (0.5 GB) does not.
          Queue.recordSample(dir, { ...MAC_28, at: LATER - 8_000 }, {});
          Queue.recordSample(dir, { ...MAC_28, at: LATER }, {});
          const started = () =>
            Queue.read(dir).flatMap((e) => (e.startedAt === null ? [] : [e.id]));
          for (const id of ["big", "small", "small2"]) Queue.tryStart(dir, id, LATER);
          expect(started()).toEqual(["holder", "small"]);
          // Once the start settles, the head says what it needs.
          Queue.recordSample(dir, { ...MAC_28, at: LATER + 8_000 }, {});
          Queue.recordSample(dir, { ...MAC_28, at: LATER + 16_000 }, {});
          yield* TestClock.setTime(LATER + 16_000);
          expect((yield* queue.state).reasons["big"]).toBe(
            "needs ~1.5 GB; 4.5 GB free, 3.2 GB kept spare",
          );

          // Past its patience the head lets nothing by, and starts once the Mac frees up.
          const patient = LATER + 5 * 60_000;
          yield* TestClock.setTime(patient);
          Queue.remove(dir, "small");
          Queue.recordSample(dir, { ...MAC_28, at: patient - 8_000 }, {});
          Queue.recordSample(dir, { ...MAC_28, at: patient }, {});
          for (const id of ["big", "small2"]) Queue.tryStart(dir, id, patient);
          expect(started()).toEqual(["holder"]);
          Queue.remove(dir, holder.id);
          for (const id of ["big", "small2"]) Queue.tryStart(dir, id, patient);
          expect(started()).toEqual(["big"]);
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
        expect(yield* queue.state).toMatchObject({
          macMemoryFloorPercent: 20,
          macCpuCeilingPercent: 70,
          heavyOverLimitSeconds: 20,
        });
        yield* queue.setMacMemoryFloorPercent(30);
        yield* queue.setMacCpuCeilingPercent(90);
        yield* queue.setHeavyOverLimitSeconds(60);
        expect(yield* queue.state).toMatchObject({
          macMemoryFloorPercent: 30,
          macCpuCeilingPercent: 90,
          heavyOverLimitSeconds: 60,
        });
        expect(yield* queue.state).toMatchObject({
          lightJobMegabytes: 512,
          headPatienceMinutes: 5,
        });
        yield* queue.setAdmissionLimits({ lightJobMegabytes: 256, headPatienceMinutes: 30 });
        expect(yield* queue.state).toMatchObject({
          lightJobMegabytes: 256,
          unseenHeavyMegabytes: 1536,
          headPatienceMinutes: 30,
        });
        // Reset sends the default back.
        yield* queue.setAdmissionLimits({ lightJobMegabytes: 512 });
        expect((yield* queue.state).lightJobMegabytes).toBe(512);
        const above = yield* Effect.flip(queue.setAdmissionLimits({ unseenMediumMegabytes: 4096 }));
        expect([above.reason, above.message]).toEqual([
          "not-allowed",
          "A medium job's memory guess can't be more than a heavy job's (1536 MB).",
        ]);
        expect((yield* queue.state).unseenMediumMegabytes).toBe(512);
        expect((yield* Effect.flip(queue.move("zzz", null))).reason).toBe("not-found");
        yield* queue.setRule("/proj", null);
        expect((yield* queue.state).rules).toEqual([]);
      }),
    ),
  );

  it.effect("lists learned routes and forgets one or all, again harmlessly", () =>
    withQueue((dir, queue) =>
      Effect.gen(function* () {
        const fault = { kind: "missing-program", subject: "vp", line: "vp: not found" } as const;
        recordRouteFault(dir, "vp@/a#missing-program", fault, 0, 7, 9);
        recordRouteFault(dir, "vp@/a#missing-program", fault, 0, 7, 9);
        recordRouteFault(dir, "cargo@/b#missing-program", fault, 0, 7, 9);
        const { routes } = yield* queue.listRoutes();
        const learnAfter = routes[0]!.learnAfter;
        expect(routes).toEqual([
          {
            key: "vp@/a#missing-program",
            kind: "missing-program",
            faults: 2,
            learnAfter,
            learned: 2 >= learnAfter,
            line: "vp: not found",
            lastFaultAt: "1970-01-01T00:00:00.000Z",
            expiresAt: expect.stringMatching(/^1970-01-/),
          },
          expect.objectContaining({ key: "cargo@/b#missing-program", faults: 1, learned: false }),
        ]);
        expect(yield* queue.forgetRoutes("vp@/a#missing-program")).toEqual({ removed: 1 });
        expect(yield* queue.forgetRoutes("vp@/a#missing-program")).toEqual({ removed: 0 });
        expect(yield* queue.forgetRoutes("all")).toEqual({ removed: 1 });
        expect(yield* queue.forgetRoutes("all")).toEqual({ removed: 0 });
        expect(yield* queue.listRoutes()).toEqual({ routes: [] });
        NodeFS.writeFileSync(NodePath.join(dir, "routes.json"), "{not json");
        const damaged = yield* queue.listRoutes();
        expect(damaged.routes).toEqual([]);
        expect(damaged.warning).toContain("routes.json.corrupt-");
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

describe("Linux as clients see it", () => {
  const block = (enabled: boolean) => ({
    global: { ...DEFAULT_PROJECT_CONFIG, runnerEnabled: enabled },
    machine: { ...DEFAULT_MACHINE_CONFIG, runnerHost: "pc", runnerLinuxSlots: 3 },
    projects: [],
    publisher: { pid: process.pid, home: "/h", primary: true },
  });

  it("is null while the Runner is off everywhere, and sums Linux jobs without timestamps", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-linux-"));
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).toBeNull();
    Queue.publishRunner(dir, block(false));
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).toBeNull();
    Queue.publishRunner(dir, block(true));
    // Failures closer than half a heartbeat are one outage, so these are a minute apart.
    const at = Date.parse("2026-01-01T00:00:00.000Z");
    Queue.recordHealth(dir, { ok: false, error: "refused" }, at);
    Queue.recordHealth(dir, { ok: false, error: "refused" }, at + 60_000);
    Queue.enqueue(dir, { ...holder, startedAt: "2026-01-01T00:00:00.000Z", runner: "linux" });
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).toEqual({
      host: "pc",
      online: false,
      slots: 3,
      running: 1,
      cpuPercent: null,
      load1: null,
      cpuCount: null,
      availableMemoryBytes: null,
      totalMemoryBytes: null,
      error: "refused",
      status: "offline",
    });
    Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat("1.234 1 1 1/1 1\n6\n") });
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).toMatchObject({
      online: true,
      load1: 1.2,
      cpuCount: 6,
      status: "online",
    });
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).not.toHaveProperty("error");
  });

  it("lists work outside the queue while Linux answers, never a running job's own copy", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-linux-"));
    Queue.publishRunner(dir, block(true));
    const container = {
      cgroup: "/system.slice/docker-1.scope",
      pid: 9,
      cpu: 5.8,
      memoryBytes: 8 * 1024 ** 3,
      command: "yes",
      container: { id: "0123456789ab", name: "erp-ci", image: "alpine" },
      threadId: "teste",
    };
    // Still syncing: its copy has no session yet, so the heartbeat cannot tell it is the queue's.
    const syncing = { ...container, cgroup: "/s.scope", runId: "app-0123abcd" };
    // An ssh job's session, tagged by the job id its ssh sent: the job's, with its memory.
    const session = { cgroup: "/u/session-12.scope", pid: 7, cpu: 2, memoryBytes: 3 * 1024 ** 3 };
    Queue.enqueue(dir, {
      ...holder,
      id: "ssh-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      runner: "linux",
      phase: "running",
      ssh: true,
    });
    Queue.enqueue(dir, {
      ...holder,
      startedAt: "2026-01-01T00:00:00.000Z",
      runner: "linux",
      remote: { id: "app-0123abcd" },
    });
    const at = Date.parse("2026-01-01T00:00:00.000Z");
    const tagged = { ...session, command: "", jobId: "ssh-1" };
    const reading = {
      ...parseHeartbeat("1 1 1 1/1 1\n6\n"),
      outside: [container, syncing, tagged],
    };
    Queue.recordHealth(dir, { ok: true, reading }, at);
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))?.outside).toEqual([container]);
    expect(Queue.read(dir).find((entry) => entry.id === "ssh-1")).toMatchObject({
      memory: 3 * 1024 ** 3,
      peakMemory: 3 * 1024 ** 3,
    });
    Queue.recordHealth(dir, { ok: false, error: "refused" }, at + 60_000);
    Queue.recordHealth(dir, { ok: false, error: "refused" }, at + 120_000);
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).not.toHaveProperty("outside");
  });

  it("words free memory as its gauge does: 819 MB, never 0.8 GB", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-linux-"));
    Queue.publishRunner(dir, block(true));
    const at = Date.parse("2026-01-01T00:00:00.000Z");
    const short = ["0.40 0.30 0.20 1/900 4321", "6", "MemTotal:       12582912 kB"];
    const reading = parseHeartbeat([...short, "MemAvailable:     838656 kB"].join("\n"));
    for (const beat of [0, 20_000, 40_000]) {
      Queue.recordHealth(dir, { ok: true, reading }, at + beat);
    }
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).toMatchObject({
      status: "over-limit",
      availableMemoryBytes: 819 * 1024 ** 2,
      overLimitBy: "819 MB free, keeping 20%",
    });
  });

  it("names the limit Linux is over, and tells not answering from offline", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-linux-"));
    Queue.publishRunner(dir, block(true));
    const at = Date.parse("2026-01-01T00:00:00.000Z");
    // Load 206 over an idle CPU, memory stalled 57%: held for memory, never for the load.
    const thrashing = [
      "206.00 180.00 120.00 9/900 4321",
      "6",
      "MemTotal:       12582912 kB",
      "MemAvailable:    5242880 kB",
      "psi memory full avg10=57.00 avg60=55.00 avg300=57.00 total=3",
    ].join("\n");
    for (const beat of [0, 20_000, 40_000]) {
      Queue.recordHealth(dir, { ok: true, reading: parseHeartbeat(thrashing) }, at + beat);
    }
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).toMatchObject({
      status: "over-limit",
      overLimitBy: "memory stalled 57% of the time (limit 10%)",
      overLimits: [{ limit: "memory-pressure", value: 57, threshold: 10 }],
    });
    const timedOut = { ok: false as const, error: "Connection timed out during banner exchange" };
    Queue.recordHealth(dir, { ...timedOut, unresponsive: true }, at + 60_000);
    Queue.recordHealth(dir, { ...timedOut, unresponsive: true }, at + 120_000);
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).toMatchObject({
      online: false,
      status: "unresponsive",
      error: "Connection timed out during banner exchange",
    });
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).not.toHaveProperty("overLimitBy");
    expect(HeavyQueue.linuxState(Queue.readDoc(dir))).not.toHaveProperty("overLimits");
  });
});
