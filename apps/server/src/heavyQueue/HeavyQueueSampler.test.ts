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

  it("skips waiting entries and entries missing from the snapshot", () => {
    expect(peaks([entry("w", 20, false), entry("gone", 99, true)])).toEqual({});
  });

  it("counts footprint instead of resident bytes, even for a job outside this server's tree", () => {
    expect(
      Sampler.peaksOf([entry("a", 10, true), entry("out", 99, true)], processes, {
        a: 5000,
        out: 7000,
      }),
    ).toEqual({ a: { cpu: 3, memoryBytes: 5000 }, out: { cpu: 0, memoryBytes: 7000 } });
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
});

const peaks = (entries: HeavyQueueEntry[]) => Sampler.peaksOf(entries, processes);

const runSampler = (dir: string, platform: NodeJS.Platform) =>
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
  it.effect("publishes the machine reading and the running job's peak into the queue file", () =>
    withRunning((dir) =>
      Effect.gen(function* () {
        yield* runSampler(dir, "linux");
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
        // A device's pid is read in the same call, with no job running.
        const device = yield* Sampler.readFootprints([jobs[1]!], [process.pid]);
        expect(device.jobs).toEqual({});
        expect(device.byPid.get(process.pid)).toBeGreaterThan(1024 ** 2);
      }
      const elsewhere = yield* Sampler.readFootprints(jobs, [process.pid]).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(elsewhere).toEqual({ jobs: {}, byPid: new Map() });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
