import type { HeavyQueueEntry } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  dropTarget,
  formatDuration,
  moveTarget,
  ordinal,
  projectForCwd,
  queueSummary,
  usageLine,
  readableLabel,
  ruleForRoot,
} from "./heavyQueueModel.ts";

const e = (id: string, started = false): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label: id,
  cwd: "/",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: started ? "2026-01-01T00:00:01.000Z" : null,
});
const entries = [e("r", true), e("a"), e("b"), e("c"), e("d")];

describe("projectForCwd", () => {
  const projects = [
    { workspaceRoot: "/w/app" },
    { workspaceRoot: "/w/app/pkg/" },
    { workspaceRoot: "/w/other" },
  ];
  it.each([
    ["/w/app", "/w/app"],
    ["/w/app/src", "/w/app"],
    ["/w/app/pkg/x", "/w/app/pkg/"],
    ["/w/application", undefined],
    ["/elsewhere", undefined],
  ])("%s -> %s", (cwd, root) => {
    expect(projectForCwd(projects, cwd)?.workspaceRoot).toBe(root);
  });

  it("matches windows separators", () => {
    expect(projectForCwd([{ workspaceRoot: "C:\\w\\app" }], "C:\\w\\app\\src")).toBeDefined();
  });
});

describe("moveTarget and dropTarget", () => {
  it.each([
    ["b", "next", "a"],
    ["a", "next", undefined],
    ["c", "up", "b"],
    ["a", "up", undefined],
    ["b", "down", "d"],
    ["c", "down", null],
    ["d", "down", undefined],
    ["a", "end", null],
    ["d", "end", undefined],
    ["r", "end", undefined],
    ["zzz", "up", undefined],
  ] as const)("%s %s -> %s", (id, action, expected) => {
    expect(moveTarget(entries, id, action)).toBe(expected);
  });

  it.each([
    ["d", "b", "b"],
    ["a", "c", "d"],
    ["a", "d", null],
    ["b", "b", undefined],
    ["b", "r", undefined],
  ])("dropping %s on %s lands before %s", (id, over, expected) => {
    expect(dropTarget(entries, id, over)).toBe(expected);
  });
});

describe("usageLine", () => {
  const GB = 1024 ** 3;
  const machine = { busyCores: 1, cpuCount: 8, availableMemoryBytes: GB, totalMemoryBytes: 8 * GB };
  const run = { ...e("r", true), cpu: 2.04, memory: 3.25 * GB, peakCpu: 4, peakMemory: 5 * GB };
  const usual = (durationMs: number) => ({ b: { cpu: 3.96, memoryBytes: 2.5 * GB, durationMs } });
  it.each([
    [
      "current and peak with the share",
      run,
      { machine },
      "Using 2.0 cores (26%) · 3.3 GB · peak 4.0 cores · 5.0 GB",
    ],
    [
      "no share without a reading",
      run,
      { machine: null },
      "Using 2.0 cores · 3.3 GB · peak 4.0 cores · 5.0 GB",
    ],
    [
      "peak only when older",
      { ...e("r", true), peakCpu: 1, peakMemory: GB },
      { machine },
      "peak 1.0 cores · 1.0 GB",
    ],
    ["nothing before a sample", e("r", true), { machine }, null],
    [
      "usual in seconds",
      e("b"),
      { machine, estimates: usual(45_000) },
      "Usually ~4.0 cores · 2.5 GB · 45s",
    ],
    [
      "usual in minutes",
      e("b"),
      { machine, estimates: usual(150_000) },
      "Usually ~4.0 cores · 2.5 GB · 3 min",
    ],
    [
      "usual in hours",
      e("b"),
      { machine, estimates: usual(5_400_000) },
      "Usually ~4.0 cores · 2.5 GB · 1.5 h",
    ],
    ["nothing without history", e("b"), { machine, estimates: {} }, null],
  ])("%s", (_name, entry, state, expected) => {
    expect(usageLine(entry, state)).toBe(expected);
  });
});

describe("summary and formatting", () => {
  const base = { entries, enabled: true, paused: false, maxRunning: 3, room: true, machine: null };
  it("reads the slots, pause and headroom", () => {
    expect(queueSummary(base)).toBe("1 of 3 running");
    expect(queueSummary({ ...base, room: false })).toBe("1 of 3 running · waiting for headroom");
    expect(queueSummary({ ...base, paused: true })).toBe("1 of 3 running · paused");
    expect(queueSummary({ ...base, enabled: false, paused: true, room: false })).toBe(
      "Queue off: heavy jobs start right away",
    );
    expect(
      queueSummary({
        ...base,
        machine: {
          busyCores: 2,
          cpuCount: 8,
          availableMemoryBytes: 11.25 * 1024 ** 3,
          totalMemoryBytes: 32 * 1024 ** 3,
        },
      }),
    ).toBe("1 of 3 running · Mac has room · CPU 25% · 11.3 GB free");
  });

  it("finds a rule by folder ignoring trailing slashes", () => {
    expect(ruleForRoot([{ root: "/w/app", priority: "first" }], "/w/app/")?.priority).toBe("first");
    expect(ruleForRoot([], "/w")).toBeUndefined();
  });

  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [21, "21st"],
    [112, "112th"],
  ])("ordinal %i", (n, expected) => expect(ordinal(n)).toBe(expected));

  it("makes command labels readable and bounded", () => {
    expect(readableLabel("/tmp/scratch/gate.sh --all")).toBe("gate.sh --all");
    expect(readableLabel("pnpm test")).toBe("pnpm test");
    const long = readableLabel(`run ${"x".repeat(200)}`);
    expect(long).toHaveLength(90);
    expect(long.endsWith("…")).toBe(true);
  });

  it("formats elapsed time", () => {
    const now = Date.parse("2026-01-01T02:05:00.000Z");
    expect(formatDuration("2026-01-01T02:04:55.000Z", now)).toBe("5s");
    expect(formatDuration("2026-01-01T01:55:00.000Z", now)).toBe("10m");
    expect(formatDuration("2026-01-01T00:00:00.000Z", now)).toBe("2h 5m");
  });
});
