import type { HeavyQueueEntry } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  dropTarget,
  formatDuration,
  moveTarget,
  ordinal,
  projectForCwd,
  queueSummary,
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

describe("summary and formatting", () => {
  const base = { entries, paused: false, maxRunning: 3, room: true, machine: null };
  it("reads the slots, pause and headroom", () => {
    expect(queueSummary(base)).toBe("1 of 3 running · Mac has room");
    expect(queueSummary({ ...base, room: false })).toBe("1 of 3 running · waiting for headroom");
    expect(queueSummary({ ...base, paused: true })).toBe("1 of 3 running · paused");
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
