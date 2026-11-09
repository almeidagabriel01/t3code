// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
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

describe("HeavyQueueSampler", () => {
  it.effect("publishes the machine reading and the running job's peak into the queue file", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-sampler-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      Queue.enqueue(dir, entry("a", process.pid, false));
      Queue.tryStart(dir, "a");
      yield* Layer.build(
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
                }),
              }),
              Layer.mock(ResourceTelemetry)({
                refresh: Effect.succeed({ processes: [proc(process.pid, 1, 200, 77)] } as never),
              }),
            ),
          ),
        ),
      );
      yield* Effect.yieldNow;
      const doc = Queue.readDoc(dir);
      expect(doc.sample).toMatchObject({
        cpuCount: 8,
        availableMemoryBytes: 5,
        totalMemoryBytes: 10,
      });
      expect(doc.entries[0]).toMatchObject({ cpu: 2, memory: 77, peakCpu: 2, peakMemory: 77 });
    }).pipe(Effect.scoped),
  );
});
