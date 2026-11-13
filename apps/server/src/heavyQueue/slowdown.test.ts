// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import type { Sample } from "./admission.ts";
import { DEFAULT_MACHINE_CONFIG } from "./runner.ts";
import { applySlowdown, isNoop, slowdownStep } from "./slowdown.ts";

const NOW = 100_000;

const proc = (pid: number, ppid: number, startTimeMs = 1) =>
  ({ identity: { pid, startTimeMs }, ppid }) as ResourceTelemetryProcess;

const job = (id: string, pid: number, more: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id,
  pid,
  threadId: "t",
  label: "./gradlew assembleRelease",
  cwd: "/repo",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  priority: "low",
  ...more,
});

// Agent job 10 runs 11; the user's job 20 runs 21; daemon 50 works for job 10.
const processes = [proc(10, 5), proc(11, 10), proc(20, 5), proc(21, 20), proc(50, 1)];

const sample = (slow: boolean, at = NOW): Sample =>
  ({
    at,
    busyCores: 9,
    cpuCount: 10,
    availableMemoryBytes: 1,
    totalMemoryBytes: 1,
    headroomSince: null,
    slow: { overLimit: slow, overLimitSince: null, underLimitSince: null },
  }) as Sample;

const step = (input: {
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly sample?: Sample | null;
  readonly enabled?: boolean;
  readonly slowedDaemons?: ReadonlyArray<{ pid: number; startTimeMs: number }>;
}) =>
  slowdownStep(
    {
      entries: input.entries,
      sample: input.sample === undefined ? sample(true) : input.sample,
      runner:
        input.enabled === undefined
          ? null
          : { machine: { ...DEFAULT_MACHINE_CONFIG, heavySlowAgentJobs: input.enabled } },
      slowedDaemons: input.slowedDaemons ?? [],
    },
    processes,
    NOW,
  );

describe("slowdownStep", () => {
  it.each([
    {
      name: "over the ceiling, slows an agent's job, its tree and its daemons",
      input: { entries: [job("a", 10, { daemons: [50] }), job("u", 20, { priority: "normal" })] },
      expected: {
        slowed: ["a"],
        restored: [],
        lower: [10, 11, 50],
        raise: [],
        slowedDaemons: [{ pid: 50, startTimeMs: 1 }],
      },
    },
    {
      name: "keeps a slowed job slowed, lowering only a daemon it picked up since",
      input: {
        entries: [job("a", 10, { slowed: true, qos: "background", daemons: [50] })],
        slowedDaemons: [],
      },
      expected: {
        slowed: [],
        restored: [],
        lower: [50],
        raise: [],
        slowedDaemons: [{ pid: 50, startTimeMs: 1 }],
      },
    },
    {
      name: "with room again, restores the job and its daemons",
      input: {
        entries: [job("a", 10, { slowed: true, qos: "background", daemons: [50] })],
        sample: sample(false),
        slowedDaemons: [{ pid: 50, startTimeMs: 1 }],
      },
      expected: { slowed: [], restored: ["a"], lower: [], raise: [10, 11, 50], slowedDaemons: [] },
    },
    {
      name: "restores a daemon whose job ended, but never a reused pid",
      input: {
        entries: [],
        slowedDaemons: [
          { pid: 50, startTimeMs: 1 },
          { pid: 11, startTimeMs: 999 },
        ],
      },
      expected: { slowed: [], restored: [], lower: [], raise: [50], slowedDaemons: [] },
    },
    {
      name: "switched off, restores everything it slowed",
      input: {
        entries: [job("a", 10, { slowed: true, qos: "background" })],
        enabled: false,
      },
      expected: { slowed: [], restored: ["a"], lower: [], raise: [10, 11], slowedDaemons: [] },
    },
    {
      name: "a stale reading restores rather than slows",
      input: { entries: [job("a", 10)], sample: sample(true, NOW - 60_000) },
      expected: { slowed: [], restored: [], lower: [], raise: [], slowedDaemons: [] },
    },
    {
      name: "never touches the user's jobs, priorities the user set, Linux, server or ungated jobs",
      input: {
        entries: [
          job("normal", 20, { priority: "normal" }),
          job("high", 20, { priority: "high" }),
          job("lowered-by-user", 20, { qos: "background" }),
          job("linux", 20, { runner: "linux" }),
          job("server", 20, { server: true }),
          job("ungated", 20, { ungated: true }),
          job("waiting", 20, { startedAt: null }),
        ],
      },
      expected: { slowed: [], restored: [], lower: [], raise: [], slowedDaemons: [] },
    },
  ])("$name", ({ input, expected }) => {
    const result = step(input);
    expect(result).toEqual(expected);
    expect(isNoop(result, input.slowedDaemons ?? [])).toBe(
      expected.slowed.length +
        expected.restored.length +
        expected.lower.length +
        expected.raise.length ===
        0,
    );
  });
});

describe("applySlowdown", () => {
  it.effect("moves a process to background CPU priority and back", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- taskpolicy exists only on the real macOS host.
      if (NodeOS.platform() !== "darwin") return;
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
            stdio: "ignore",
          }),
        ),
        (spawned) => Effect.sync(() => spawned.kill("SIGKILL")),
      );
      const pid = child.pid!;
      const priority = () =>
        Number(
          NodeChildProcess.execFileSync("/bin/ps", ["-o", "pri=", "-p", String(pid)], {
            encoding: "utf8",
          }),
        );
      const none = { slowed: [], restored: [], slowedDaemons: [] };
      yield* applySlowdown({ ...none, lower: [pid], raise: [] });
      expect(priority()).toBe(4);
      yield* applySlowdown({ ...none, lower: [], raise: [pid, 999_999_999] });
      expect(priority()).toBeGreaterThan(4);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
