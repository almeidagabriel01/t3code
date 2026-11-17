import { describe, expect, it } from "@effect/vitest";
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
import type { ProcessOwner } from "@t3tools/shared/ProcessOwners";

import {
  classifyHeavyCommands,
  DETACHED_REASON,
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
  readonly serverPid?: number;
  readonly now?: number;
  readonly previous?: ReadonlyMap<string, Tracked>;
}) =>
  classifyHeavyCommands({
    owners: [agent(10)],
    entries: [],
    serverPid: 1,
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
    ["pnpm run dev", true],
    ["vitest --watch", true],
    ["vp test run", undefined],
  ] as const)("marks %s as keeping running: %s", (command, keepsRunning) => {
    const processes = [SERVER, CLAUDE, WRAPPER, proc(12, 11, "node", { cpu: 400 }, command)];
    expect(classify({ processes }).commands[0]?.keepsRunning).toBe(keepsRunning);
  });

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
      name: "keeps megabytes for a CPU-heavy command under a gigabyte",
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(12, 11, "node", { cpu: 100, rss: 33 * 1024 ** 2 }, "node -e while(1){}"),
      ],
      expected: [{ source: "agent", pid: 12, threadId: "t-agent", cpu: 1, memory: 33 * 1024 ** 2 }],
    },
    {
      name: "never shows a running CPU-heavy command as using no memory",
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(12, 11, "yes", { cpu: 100, rss: 300 * 1024 }, "yes"),
      ],
      expected: [{ source: "agent", pid: 12, threadId: "t-agent", cpu: 1, memory: 1024 ** 2 }],
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

  // Outside the server's tree; pid 0 stands for launchd, whose pid 1 the fixtures give the server.
  const SCRIPT = [
    proc(70, 0, "sh", {}, "sh mac-all.sh"),
    proc(71, 70, "bash", {}, "/bin/bash ./real.sh"),
  ];
  it.each([
    {
      name: "lists a detached script's heavy command once, with the tree beneath it",
      processes: [
        ...SCRIPT,
        proc(72, 71, "node", { cpu: 20 }, "npm exec playwright test"),
        proc(73, 72, "sh", {}, "sh -c playwright test"),
        proc(74, 73, "node", { cpu: 80 }, "node /w/node_modules/.bin/playwright test"),
        proc(75, 74, "node", { cpu: 300, rss: GIB }),
      ],
      expected: [{ source: "detached", pid: 72, threadId: null, cpu: 4, memory: GIB }],
    },
    {
      name: "reads a node script's program past the interpreter and its flags",
      processes: [
        proc(80, 0, "node", { cpu: 200 }, "/usr/bin/node --max-old-space-size=8192 /w/.bin/tsc"),
      ],
      expected: [{ source: "detached", pid: 80, threadId: null, cpu: 2, memory: 0 }],
    },
    {
      name: "leaves out a detached heavy command while it is light",
      processes: [...SCRIPT, proc(72, 71, "node", { cpu: 20 }, "npm exec playwright test")],
      expected: [],
    },
    {
      name: "leaves out a busy process whose command is not heavy work",
      processes: [proc(80, 0, "Google Chrome", { cpu: 400, rss: 3 * GIB })],
      expected: [],
    },
    {
      name: "reads only a process's own program, not words its argv lost quotes around",
      processes: [
        proc(80, 0, "ssh", { cpu: 100 }, "ssh pc cd /w && npm test"),
        proc(81, 0, "claude", { cpu: 100 }, "claude -p fix it; npm test"),
      ],
      expected: [],
    },
    {
      name: "leaves out heavy tools an app runs as helpers",
      processes: [
        proc(60, 0, "Code Helper (Plugin)"),
        proc(61, 60, "tsgo", { cpu: 200, rss: 2 * GIB }, "/x/tsgo --lsp --stdio"),
      ],
      expected: [],
    },
    {
      name: "keeps an agent's command an agent's, and never a young one as detached",
      processes: [
        SERVER,
        CLAUDE,
        WRAPPER,
        proc(12, 11, "vitest", { cpu: 400 }),
        proc(13, 11, "vitest", { cpu: 400, runMs: 1_000 }),
        ...SCRIPT,
        proc(72, 71, "vitest", { cpu: 100 }),
      ],
      expected: [
        { source: "agent", pid: 12, threadId: "t-agent", cpu: 4, memory: 0 },
        { source: "detached", pid: 72, threadId: null, cpu: 1, memory: 0 },
      ],
    },
    {
      name: "never lists T3's own work outside an owner",
      processes: [SERVER, proc(5, 1, "git", { cpu: 200 }, "git commit -m checkpoint")],
      expected: [],
    },
    {
      name: "never lists the launcher that runs this T3, nor its other children",
      serverPid: 91,
      processes: [
        proc(89, 0, "zsh", {}, "-zsh"),
        proc(90, 89, "node", { cpu: 100 }, "node /w/node_modules/.bin/vp run dev:desktop"),
        proc(91, 90, "node", { cpu: 100 }, "node apps/server/src/bin.ts"),
        proc(92, 90, "node", { cpu: 100 }, "node /w/node_modules/.bin/tsc --watch"),
      ],
      owners: [],
      expected: [],
    },
    {
      name: "leaves a hooked session's queue job to its queue row",
      processes: [
        proc(70, 0, "claude"),
        proc(71, 70, "node", {}, "t3 heavy -- vp test"),
        proc(72, 71, "vitest", { cpu: 400 }),
      ],
      entries: [entry({ pid: 71 })],
      expected: [
        { source: "queue", pid: 71, threadId: "t-agent", cpu: undefined, memory: undefined },
      ],
    },
    {
      name: "counts a queue job's build daemon in its row, not as detached work",
      processes: [
        proc(70, 0, "claude"),
        proc(71, 70, "node", {}, "t3 heavy -- ./gradlew assembleRelease"),
        proc(80, 0, "java", { cpu: 100 }, "java org.gradle.launcher.daemon.bootstrap.GradleDaemon"),
        proc(81, 80, "sh", {}, "sh -c tsc -b"),
        proc(82, 81, "node", { cpu: 300 }, "node /w/node_modules/.bin/tsc -b"),
      ],
      entries: [entry({ pid: 71, daemons: [80, 81, 82] })],
      expected: [
        { source: "queue", pid: 71, threadId: "t-agent", cpu: undefined, memory: undefined },
      ],
    },
  ])("$name", ({ processes, expected, ...rest }) => {
    expect(summary(classify({ processes, ...rest }))).toEqual(expected);
  });

  it("gives a detached command its reason and no Stop", () => {
    const result = classify({
      processes: [...SCRIPT, proc(72, 71, "vitest", { cpu: 100 }, "vitest run")],
    });
    expect(
      result.commands.map(({ stoppable, reason, name }) => ({ stoppable, reason, name })),
    ).toEqual([{ stoppable: false, reason: DETACHED_REASON, name: "Tests" }]);
    expect(result.trees.has("72:1072")).toBe(false);
    expect(result.tracked.has("72:1072")).toBe(true);
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

  it("says where a queue row runs, and gives a Linux row none of the wrapper's usage", () => {
    const usage = { cpu: 0.04, memory: 30e6, peakCpu: 0.1, peakMemory: 40e6 };
    const result = classify({
      processes: [SERVER],
      entries: [
        entry({ id: "mac", pid: 1, server: true, ...usage }),
        entry({ id: "linux", pid: 2, server: true, runner: "linux", ...usage }),
      ],
    });
    const [mac, linux] = result.commands;
    expect(mac).not.toHaveProperty("runner");
    expect(mac).toMatchObject({ cpu: 0, peakCpu: 0.1 });
    expect(linux).toMatchObject({ runner: "linux" });
    for (const key of ["cpu", "memory", "peakCpu", "peakMemory"]) {
      expect(linux).not.toHaveProperty(key);
    }
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
