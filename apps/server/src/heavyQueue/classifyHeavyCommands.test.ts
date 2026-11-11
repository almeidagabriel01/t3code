import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
import type { ProcessOwner } from "@t3tools/shared/ProcessOwners";

import {
  classifyHeavyCommands,
  HEAVY_MEMORY_BYTES,
  LINGER_MS,
  type Tracked,
} from "./classifyHeavyCommands.ts";

const GIB = HEAVY_MEMORY_BYTES;

const proc = (
  pid: number,
  ppid: number,
  name: string,
  usage: { readonly cpu?: number; readonly rss?: number; readonly runMs?: number } = {},
  command = name,
) =>
  ({
    identity: { pid, startTimeMs: 1_000 + pid },
    ppid,
    name,
    command,
    cpuPercent: usage.cpu ?? 0,
    residentBytes: usage.rss ?? 0,
    runTimeMs: usage.runMs ?? 60_000,
  }) as ResourceTelemetryProcess;

const agent = (pid: number, threadId = "t-agent"): ProcessOwner => ({
  kind: "agent",
  pid,
  threadId,
});

const entry = (over: Partial<HeavyQueueEntry> & { readonly pid: number }): HeavyQueueEntry => ({
  id: "q1",
  threadId: "t-agent",
  label: "vp test run",
  cwd: "/work/app",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  ...over,
});

// 1 server → 10 claude (agent) → 11 zsh -c wrapper → commands below.
const SERVER = proc(1, 0, "node");
const CLAUDE = proc(10, 1, "claude", { cpu: 300 });
const WRAPPER = proc(11, 10, "/bin/zsh", {}, "/bin/zsh -c source snapshot && eval 'vp test'");

const classify = (input: {
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly owners?: ReadonlyArray<ProcessOwner>;
  readonly entries?: ReadonlyArray<HeavyQueueEntry>;
  readonly now?: number;
  readonly previous?: ReadonlyMap<string, Tracked>;
}) =>
  classifyHeavyCommands({
    owners: [agent(10)],
    entries: [],
    now: 100_000,
    previous: new Map(),
    ...input,
  });

const summary = (result: ReturnType<typeof classify>) =>
  result.commands.map((command) => ({
    source: command.source,
    pid: command.pid,
    threadId: command.threadId,
    cpu: command.cpu,
    memory: command.memory,
  }));

describe("classifyHeavyCommands", () => {
  it.each([
    {
      name: "sums a command's whole tree under the agent's shell wrapper",
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(12, 11, "node", { cpu: 150, rss: 0.2 * GIB }, "node vp test run"),
        proc(13, 12, "node", { cpu: 200, rss: 0.3 * GIB }),
      ],
      expected: [{ source: "agent", pid: 12, threadId: "t-agent", cpu: 3.5, memory: 0.5 * GIB }],
    },
    {
      name: "leaves out a light command",
      processes: [SERVER, CLAUDE, WRAPPER, proc(12, 11, "git", { cpu: 10, rss: 0.1 * GIB })],
      expected: [],
    },
    {
      name: "lists a command heavy on memory alone",
      processes: [SERVER, CLAUDE, WRAPPER, proc(12, 11, "java", { rss: 1.5 * GIB })],
      expected: [{ source: "agent", pid: 12, threadId: "t-agent", cpu: 0, memory: 1.5 * GIB }],
    },
    {
      name: "counts many light workers together",
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(12, 11, "vitest", { cpu: 10 }),
        ...[13, 14, 15, 16, 17].map((pid) => proc(pid, 12, "node", { cpu: 10 })),
      ],
      expected: [{ source: "agent", pid: 12, threadId: "t-agent", cpu: 0.6, memory: 0 }],
    },
    {
      name: "waits out a root younger than three seconds",
      processes: [SERVER, CLAUDE, WRAPPER, proc(12, 11, "rg", { cpu: 400, runMs: 1_000 })],
      expected: [],
    },
    {
      name: "never lists the agent's own process",
      processes: [SERVER, CLAUDE],
      expected: [],
    },
    {
      name: "ignores the device hub's tree",
      owners: [{ kind: "device-hub", pid: 10 } as const],
      processes: [SERVER, CLAUDE, proc(12, 10, "qemu", { cpu: 400 })],
      expected: [],
    },
    {
      name: "lists a terminal's command under the terminal's thread",
      owners: [{ kind: "terminal", pid: 20, threadId: "t-term", terminalId: "default" } as const],
      processes: [SERVER, proc(20, 1, "-zsh"), proc(21, 20, "cargo", { cpu: 400 })],
      expected: [{ source: "terminal", pid: 21, threadId: "t-term", cpu: 4, memory: 0 }],
    },
    {
      name: "gives a nested agent's command to that agent, not the outer one",
      owners: [agent(10, "t-outer"), agent(30, "t-inner")],
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(30, 11, "claude"),
        proc(31, 30, "zsh"),
        proc(32, 31, "tsc", { cpu: 100 }),
      ],
      expected: [{ source: "agent", pid: 32, threadId: "t-inner", cpu: 1, memory: 0 }],
    },
  ])("$name", ({ processes, owners, expected }) => {
    expect(summary(classify({ processes, ...(owners === undefined ? {} : { owners }) }))).toEqual(
      expected,
    );
  });

  it.each([
    {
      name: "a queued command shows once, as its queue entry",
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(12, 11, "node", {}, "t3 heavy -- vp test"),
        proc(13, 12, "node", { cpu: 400 }),
      ],
      entries: [entry({ pid: 12, cpu: 4, memory: 1.04 * GIB })],
      expected: [{ source: "queue", pid: 12, threadId: "t-agent", cpu: 4, memory: GIB }],
    },
    {
      name: "a wrapper around a queued command does not count it again",
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(12, 11, "timeout"),
        proc(13, 12, "node", {}, "t3 heavy -- vp test"),
        proc(14, 13, "node", { cpu: 400 }),
      ],
      entries: [entry({ pid: 13 })],
      expected: [
        { source: "queue", pid: 13, threadId: "t-agent", cpu: undefined, memory: undefined },
      ],
    },
    {
      name: "a server-held entry claims nothing, though the server is every tree's ancestor",
      processes: [SERVER, CLAUDE, WRAPPER, proc(12, 11, "tsc", { cpu: 100 })],
      entries: [entry({ pid: 1, server: true, threadId: null })],
      expected: [
        { source: "queue", pid: 1, threadId: null, cpu: undefined, memory: undefined },
        { source: "agent", pid: 12, threadId: "t-agent", cpu: 1, memory: 0 },
      ],
    },
    {
      name: "waiting entries are not running commands",
      processes: [SERVER, CLAUDE],
      entries: [entry({ pid: 12, startedAt: null })],
      expected: [],
    },
  ])("$name", ({ processes, entries, expected }) => {
    expect(summary(classify({ processes, entries }))).toEqual(expected);
  });

  it("marks server-held queue work as not stoppable and names rows readably", () => {
    const result = classify({
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(12, 11, "node", { cpu: 100 }, "/usr/bin/node /x/.bin/vp test run src"),
      ],
      entries: [entry({ pid: 1, server: true, label: "git checkpoint", name: "Checkpoint" })],
    });
    expect(
      result.commands.map(({ name, stoppable, startedAt }) => ({ name, stoppable, startedAt })),
    ).toEqual([
      { name: "Checkpoint", stoppable: false, startedAt: "2026-01-01T00:00:01.000Z" },
      { name: "Tests", stoppable: true, startedAt: "1970-01-01T00:00:01.012Z" },
    ]);
  });

  it("orders direct commands oldest first and records the pids Stop may signal", () => {
    const result = classify({
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(14, 11, "tsc", { cpu: 100 }),
        proc(12, 11, "vitest", { cpu: 100 }),
        proc(13, 12, "node", { cpu: 100 }),
      ],
    });
    expect(result.commands.map((command) => command.pid)).toEqual([12, 14]);
    expect([...result.trees.get("12:1012")!].toSorted()).toEqual([12, 13]);
  });

  it("keeps a command listed through a brief dip, with its peak, then drops it", () => {
    const tree = (cpu: number) => [SERVER, CLAUDE, WRAPPER, proc(12, 11, "vitest", { cpu })];
    const steps = [
      { at: 0, cpu: 400, listed: true, peak: 4 },
      { at: 2_000, cpu: 10, listed: true, peak: 4 },
      { at: 4_000, cpu: 250, listed: true, peak: 4 },
      { at: 4_000 + LINGER_MS - 1, cpu: 10, listed: true, peak: 4 },
      { at: 4_000 + LINGER_MS, cpu: 10, listed: false, peak: undefined },
      { at: 20_000, cpu: 10, listed: false, peak: undefined },
    ];
    let previous: ReadonlyMap<string, Tracked> = new Map();
    for (const step of steps) {
      const result = classify({ processes: tree(step.cpu), now: step.at, previous });
      expect([step.at, result.commands[0]?.peakCpu]).toEqual([step.at, step.peak]);
      expect(result.commands.length > 0).toBe(step.listed);
      previous = result.tracked;
    }
  });

  it("forgets a command whose process exited", () => {
    const first = classify({
      processes: [SERVER, CLAUDE, WRAPPER, proc(12, 11, "vitest", { cpu: 400 })],
    });
    const second = classify({
      processes: [SERVER, CLAUDE, WRAPPER],
      now: 101_000,
      previous: first.tracked,
    });
    expect(second.commands).toEqual([]);
    expect(second.tracked.size).toBe(0);
  });
});
