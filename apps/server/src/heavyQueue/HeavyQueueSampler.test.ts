// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HostResources } from "../resourceTelemetry/HostResources.ts";
import { ResourceTelemetry } from "../resourceTelemetry/ResourceTelemetry.ts";
import * as Sampler from "./HeavyQueueSampler.ts";
import * as Queue from "./queueFile.ts";

const proc = (pid: number, ppid: number, cpuPercent: number, residentBytes: number) =>
  ({
    identity: { pid, startTimeMs: 0 },
    ppid,
    cpuPercent,
    residentBytes,
  }) as ResourceTelemetryProcess;

const entry = (id: string, pid: number, started: boolean): HeavyQueueEntry => ({
  id,
  pid,
  threadId: null,
  label: "vp run build",
  cwd: "/",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: started ? "2026-01-01T00:00:01.000Z" : null,
});

const processes = [
  proc(10, 1, 50, 100),
  proc(11, 10, 150, 200),
  proc(12, 11, 100, 300),
  proc(20, 1, 400, 999),
  proc(30, 1, 10, 10),
];

describe("peaksOf", () => {
  it("sums a running entry's whole process tree in cores and bytes", () => {
    expect(peaks([entry("a", 10, true)])).toEqual({ a: { cpu: 3, memoryBytes: 600 } });
  });

  it("skips waiting entries, entries missing from the snapshot and Linux jobs", () => {
    expect(peaks([entry("w", 20, false), entry("gone", 99, true)])).toEqual({});
    const linux = { ...entry("l", 10, true), runner: "linux" as const };
    expect(Sampler.peaksOf([linux], processes, { l: 5000 })).toEqual({});
  });

  it("counts footprint instead of resident bytes; a job the snapshot misses has unknown CPU", () => {
    expect(
      Sampler.peaksOf([entry("a", 10, true), entry("out", 99, true)], processes, {
        a: 5000,
        out: 7000,
      }),
    ).toEqual({ a: { cpu: 3, memoryBytes: 5000 }, out: { cpu: null, memoryBytes: 7000 } });
  });

  it("reads footprint output per pid, skipping what it could not read", () => {
    const text = `======
node [3026]: 64-bit    Footprint: 1825379008 B (16384 bytes per page)
======
    phys_footprint: 1825379008 B
qemu-system-aarch64-headless [43597]: 64-bit    Footprint: 4298000000 B (16384 bytes per page)
odd [12]: no footprint here
Summary Footprint: 6123379008 B`;
    expect([...Sampler.parseFootprint(text)]).toEqual([
      [3026, 1825379008],
      [43597, 4298000000],
    ]);
  });

  it("reserves what a device holds beyond its resident pages, and nothing for other processes", () => {
    const device = (pid: number, residentBytes: number) =>
      ({
        ...proc(pid, 1, 0, residentBytes),
        category: "external-device",
      }) as ResourceTelemetryProcess;
    const footprints = new Map([
      [40, 4_000],
      [41, 500],
      [10, 9_000],
    ]);
    // 40 has 3,000 paged out; 41 is all resident; 42 has no footprint; 10 is not a device.
    expect(
      Sampler.deviceReserve(
        [device(40, 1_000), device(41, 800), device(42, 100), processes[0]!],
        footprints,
      ),
    ).toBe(3_000);
  });

  it("adds the daemons working for a job, each process once", () => {
    // 20 is a build daemon outside 10's tree; 99 has already exited.
    const tree = Sampler.peaksOf([entry("a", 10, true)], processes, {}, {}).a!.memoryBytes;
    expect(Sampler.peaksOf([entry("a", 10, true)], processes, {}, { a: [20, 99] })).toEqual({
      a: { cpu: 7, memoryBytes: 1599, treeMemoryBytes: tree, daemons: [20] },
    });
    expect(tree).toBeLessThan(1599);
    expect(Sampler.peaksOf([entry("a", 10, true)], processes, { a: 5000 }, { a: [20] })).toEqual({
      a: { cpu: 7, memoryBytes: 5000, daemons: [20] },
    });
    // macOS measures by footprint: the tree's own footprint is the marginal cost.
    expect(
      Sampler.peaksOf([entry("a", 10, true)], processes, { a: 5000 }, { a: [20] }, { a: 1200 }),
    ).toEqual({ a: { cpu: 7, memoryBytes: 5000, treeMemoryBytes: 1200, daemons: [20] } });
  });

  it("survives a cycle in the parent links", () => {
    const cyclic = [proc(10, 11, 100, 1), proc(11, 10, 100, 1)];
    expect(Sampler.peaksOf([entry("a", 10, true)], cyclic)).toEqual({
      a: { cpu: 2, memoryBytes: 2 },
    });
  });
});

describe("recordSample", () => {
  it.each([
    {
      name: "first reading",
      readings: [[2, 100]],
      expected: { cpu: 2, memory: 100, peakCpu: 2, peakMemory: 100 },
    },
    {
      name: "load drops",
      readings: [
        [4, 300],
        [1, 50],
      ],
      expected: { cpu: 1, memory: 50, peakCpu: 4, peakMemory: 300 },
    },
    {
      name: "load rises again",
      readings: [
        [1, 50],
        [3, 200],
      ],
      expected: { cpu: 3, memory: 200, peakCpu: 3, peakMemory: 200 },
    },
  ])("keeps the latest and the peak: $name", ({ readings, expected }) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-record-"));
    try {
      Queue.enqueue(dir, entry("a", process.pid, false));
      Queue.tryStart(dir, "a");
      const machine = {
        at: 1,
        busyCores: 1,
        cpuCount: 8,
        availableMemoryBytes: 5,
        totalMemoryBytes: 10,
      };
      for (const [cpu, memoryBytes] of readings) {
        Queue.recordSample(dir, machine, { a: { cpu: cpu!, memoryBytes: memoryBytes! } });
      }
      expect(Queue.readDoc(dir).entries[0]).toMatchObject(expected);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  // CPU ceiling 70% of 10 cores = 7; the over-limit time is 20 s; one reading every 2 s.
  // The slowed job runs at 1 core and comes back at 4 (no history: a heavy job's default).
  it.each([
    {
      name: "slows only after CPU stays over the ceiling for the whole window",
      steps: [
        { seconds: 20, busy: 8, slowed: false, over: false },
        { seconds: 2, busy: 8, slowed: false, over: true },
      ],
    },
    {
      name: "a dip under the ceiling restarts the window",
      steps: [
        { seconds: 16, busy: 8, slowed: false, over: false },
        { seconds: 2, busy: 5, slowed: false, over: false },
        { seconds: 20, busy: 8, slowed: false, over: false },
        { seconds: 2, busy: 8, slowed: false, over: true },
      ],
    },
    {
      name: "stays slowed while the job at full speed would push CPU back over",
      steps: [
        { seconds: 22, busy: 8, slowed: false, over: true },
        { seconds: 60, busy: 5, slowed: true, over: true },
      ],
    },
    {
      name: "restores once there is room for the job at full speed for the whole window",
      steps: [
        { seconds: 22, busy: 8, slowed: false, over: true },
        { seconds: 20, busy: 3, slowed: true, over: true },
        { seconds: 2, busy: 3, slowed: true, over: false },
      ],
    },
  ])("$name", ({ steps }) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-slow-"));
    try {
      Queue.enqueue(dir, { ...entry("a", process.pid, false), priority: "low" });
      Queue.tryStart(dir, "a");
      let at = 0;
      for (const { seconds, busy, slowed, over } of steps) {
        const step = { slowed: slowed ? ["a"] : [], restored: [], slowedDaemons: [] };
        if (slowed) Queue.recordSlowdown(dir, step);
        for (let left = seconds; left > 0; left -= 2) {
          at += 2000;
          const reading = {
            at,
            busyCores: busy,
            cpuCount: 10,
            availableMemoryBytes: 9,
            totalMemoryBytes: 10,
          };
          Queue.recordSample(dir, reading, { a: { cpu: 1, memoryBytes: 1 } });
        }
        expect(Queue.readDoc(dir).sample?.slow?.overLimit).toBe(over);
      }
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a running job's daemons only while a sample finds them", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-record-"));
    try {
      Queue.enqueue(dir, entry("a", process.pid, false));
      Queue.tryStart(dir, "a");
      const machine = {
        at: 1,
        busyCores: 1,
        cpuCount: 8,
        availableMemoryBytes: 5,
        totalMemoryBytes: 10,
      };
      Queue.recordSample(dir, machine, { a: { cpu: 3, memoryBytes: 9, daemons: [50, 51] } });
      expect(Queue.readDoc(dir).entries[0]?.daemons).toEqual([50, 51]);
      Queue.recordSample(dir, machine, { a: { cpu: 1, memoryBytes: 9 } });
      expect(Queue.readDoc(dir).entries[0]?.daemons).toBeUndefined();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const peaks = (entries: HeavyQueueEntry[]) => Sampler.peaksOf(entries, processes);

const runSampler = (
  dir: string,
  platform: NodeJS.Platform,
  registered: Array<ReadonlyArray<{ readonly pid: number }>> = [],
) =>
  Layer.build(
    Sampler.layer(dir).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(HostResources)({
            read: Effect.succeed({
              sampledAt: 1,
              cpuUtilization: 0.2,
              cpuCount: 8,
              availableMemoryBytes: 5,
              totalMemoryBytes: 10,
              memoryPressureLevel: 2,
              swapInBytesPerSecond: 1024,
            }),
          }),
          Layer.mock(ResourceTelemetry)({
            refresh: Effect.succeed({ processes: [proc(process.pid, 1, 200, 77)] } as never),
            setJobRoots: (roots) => Effect.sync(() => void registered.push(roots)),
          }),
          NodeServices.layer,
        ),
      ),
      Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
    ),
  );

const withRunning = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-sampler-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    Queue.enqueue(dir, entry("a", process.pid, false));
    Queue.tryStart(dir, "a");
    return yield* body(dir);
  }).pipe(Effect.scoped);

describe("HeavyQueueSampler", () => {
  it.effect(
    "registers a running job's root for sampling and publishes its peak and the reading",
    () =>
      withRunning((dir) =>
        Effect.gen(function* () {
          const registered: Array<ReadonlyArray<{ readonly pid: number }>> = [];
          yield* runSampler(dir, "linux", registered);
          yield* Effect.yieldNow;
          const doc = Queue.readDoc(dir);
          expect(doc.sample).toMatchObject({
            cpuCount: 8,
            availableMemoryBytes: 5,
            totalMemoryBytes: 10,
            pressureLevel: 2,
            swapInBytesPerSecond: 1024,
          });
          expect(doc.entries[0]).toMatchObject({ cpu: 2, memory: 77, peakCpu: 2, peakMemory: 77 });
          // Its root is outside this server's tree (ppid 1), so the monitor samples it only once told.
          expect(registered).toEqual([[{ pid: process.pid, startTimeMs: 0 }]]);
        }),
      ),
  );

  it.effect("on macOS measures a job's tree by physical footprint; elsewhere it leaves RSS", () =>
    Effect.gen(function* () {
      const jobs = [entry("a", process.pid, true), entry("w", process.pid, false)];
      // oxlint-disable-next-line t3code/no-global-process-runtime -- footprint(1) exists only on the real macOS host.
      if (NodeOS.platform() === "darwin") {
        const measured = yield* Sampler.readFootprints(jobs);
        expect(Object.keys(measured.jobs)).toEqual(["a"]);
        expect(measured.jobs.a).toBeGreaterThan(1024 ** 2);
        // With no daemons, the tree alone is the whole job.
        expect(measured.trees).toEqual(measured.jobs);
        // A device's pid is read in the same call, with no job running.
        const device = yield* Sampler.readFootprints([jobs[1]!], [process.pid]);
        expect(device.jobs).toEqual({});
        expect(device.byPid.get(process.pid)).toBeGreaterThan(1024 ** 2);
      }
      const elsewhere = yield* Sampler.readFootprints(jobs, [process.pid]).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(elsewhere).toEqual({ jobs: {}, trees: {}, byPid: new Map() });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
