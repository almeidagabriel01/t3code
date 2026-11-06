import type {
  DeviceSummary,
  ResourceTelemetryProcess,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appBreakdown,
  attributeTerminalUsage,
  buildResourceTree,
  deviceShutdownTargets,
  toMachineShare,
} from "./resourceUsage.logic";

const proc = (
  pid: number,
  childPids: number[],
  residentBytes: number,
  cpuPercent: number,
  category: ResourceTelemetryProcess["category"] = "server-child",
) =>
  ({
    identity: { pid, startTimeMs: 0 },
    childPids,
    residentBytes,
    cpuPercent,
    category,
  }) as unknown as ResourceTelemetryProcess;

const processes = [
  proc(1, [], 100, 1, "electron-main"),
  proc(2, [], 50, 2, "electron-renderer"),
  proc(3, [], 10, 0, "server"),
  proc(10, [11, 12], 5, 1),
  proc(11, [13], 20, 10),
  proc(12, [], 30, 20),
  proc(13, [], 40, 5),
  proc(20, [], 7, 3),
];

describe("attributeTerminalUsage", () => {
  const { terminals, projects, claimed } = attributeTerminalUsage(processes, [
    { key: "a", projectKey: "p1", pid: 10 },
    { key: "b", projectKey: "p1", pid: 20 },
    { key: "c", projectKey: null, pid: 999 },
    { key: "d", projectKey: "p2", pid: 11 },
  ]);

  it("sums a terminal's whole subtree", () => {
    expect(terminals.get("a")).toEqual({ rssBytes: 95, cpuPercent: 36, processCount: 4 });
  });

  it("counts each pid once and rolls terminals up by project", () => {
    expect(terminals.get("d")).toEqual({ rssBytes: 0, cpuPercent: 0, processCount: 0 });
    expect(projects.get("p1")).toEqual({ rssBytes: 102, cpuPercent: 39, processCount: 5 });
    expect(projects.get("p2")?.processCount).toBe(0);
  });

  it("keeps unattributed terminals apart and tolerates unknown pids", () => {
    expect(projects.get(null)?.processCount).toBe(0);
    expect(claimed.has(13)).toBe(true);
  });
});

describe("appBreakdown", () => {
  it("leaves out claimed processes and lists each group's own, in a fixed group order", () => {
    const { claimed } = attributeTerminalUsage(processes, [{ key: "a", projectKey: "p", pid: 10 }]);
    const groups = appBreakdown(processes, claimed);
    expect(
      groups.map((row) => [
        row.group,
        row.usage.rssBytes,
        row.processes.map((process) => process.identity.pid),
      ]),
    ).toEqual([
      ["main", 100, [1]],
      ["renderer", 50, [2]],
      ["server", 10, [3]],
      ["other", 7, [20]],
    ]);
    expect(groups[3]!.usage).toEqual({ rssBytes: 7, cpuPercent: 3, processCount: 1 });
  });
});

describe("deviceShutdownTargets", () => {
  const device = (overrides: Partial<DeviceSummary>) =>
    ({
      hostId: "local",
      id: "x",
      platform: "android",
      name: "Pixel_8",
      version: "",
      booted: true,
      physical: false,
      ...overrides,
    }) as DeviceSummary;
  const devices = [
    device({ id: "emulator-5554", name: "Pixel_8" }),
    device({ id: "emulator-5556", name: "Tablet" }),
    device({ id: "Pixel_8", name: "Pixel_8", booted: false }),
    device({ id: "remote-emu", name: "Pixel_8", hostId: "mac-mini" }),
    device({ id: "phone", name: "Pixel_8", physical: true }),
    device({ id: "sim-a", platform: "ios", name: "iPhone 17" }),
    device({ id: "sim-b", platform: "ios", name: "iPad" }),
    device({ id: "sim-off", platform: "ios", name: "iPhone SE", booted: false }),
  ];
  const local = new Set(["local"]);

  it.each([
    ["the booted emulator running the row's AVD", "android", "Pixel_8", ["emulator-5554"]],
    ["every booted simulator for the Simulator app", "ios", null, ["sim-a", "sim-b"]],
    ["nothing for the device tools", "tools", null, []],
    ["nothing when the AVD is not booted here", "android", "Nexus", []],
  ] as const)("shuts down %s", (_, platform, avd, expected) => {
    expect(
      deviceShutdownTargets({ platform, avd }, devices, local).map((target) => target.deviceId),
    ).toEqual(expected);
  });
});

describe("buildResourceTree", () => {
  const p = (
    pid: number,
    childPids: number[],
    residentBytes: number,
    cpuPercent: number,
    name = "node",
    command = name,
  ) =>
    ({
      identity: { pid, startTimeMs: 0 },
      childPids,
      residentBytes,
      cpuPercent,
      category: "server-child",
      name,
      command,
    }) as unknown as ResourceTelemetryProcess;

  const table = [
    p(1, [], 5, 0, "t3-server"),
    p(10, [11], 100, 10, "zsh"), // terminal in project A, owns a build
    p(11, [], 300, 50, "gradle"),
    p(20, [21], 10, 1, "codex"), // agent in project A
    p(21, [], 200, 5, "cargo"),
    p(30, [], 40, 2, "claude"), // agent with an unknown thread
    p(40, [41, 43], 20, 0, "node", "node hub.js"), // device hub
    p(41, [42], 5, 0, "emulator", "emulator -avd Pixel_8 -no-window"),
    p(42, [], 2000, 90, "qemu-system-aarch64", "qemu-system-aarch64 -avd Pixel_8"),
    p(43, [], 30, 1, "adb"),
    p(44, [], 8, 0, "stray"), // not claimed by anything
  ];
  const run = (overrides: Partial<Parameters<typeof buildResourceTree>[0]> = {}) =>
    buildResourceTree({
      processes: table,
      terminals: [{ key: "t1:a", name: "dev", threadId: "t1", projectKey: "A", pid: 10 }],
      agents: [
        { pid: 20, threadId: "t1" },
        { pid: 30, threadId: "ghost" },
        { pid: 999, threadId: "dead" },
      ],
      hubPids: [40],
      sort: "memory",
      projectOfThread: (threadId) => (threadId === "t1" ? "A" : null),
      projectTitle: (key) => (key === null ? "Unattributed" : `Project ${key}`),
      threadTitle: (threadId) => (threadId === "t1" ? "Fix build" : "Agent"),
      ...overrides,
    });

  it("lists agents and terminals under their project, each process once", () => {
    const tree = run();
    const projectA = tree.projects.find((project) => project.projectKey === "A")!;
    expect(projectA.rows.map((row) => [row.kind, row.name, row.usage.rssBytes])).toEqual([
      ["terminal", "dev", 400],
      ["agent", "Fix build", 210],
    ]);
    expect(projectA.usage.rssBytes).toBe(610);
    expect(tree.app.find((row) => row.group === "other")?.usage).toEqual({
      rssBytes: 8 + 5,
      cpuPercent: 0,
      processCount: 2,
    });
  });

  it("puts agents of unknown threads under Unattributed and hides dead agents", () => {
    const tree = run();
    const orphan = tree.projects.find((project) => project.projectKey === null)!;
    expect(orphan.title).toBe("Unattributed");
    expect(orphan.rows.map((row) => row.name)).toEqual(["Agent"]);
    expect(
      tree.projects.flatMap((project) => project.rows).some((row) => row.threadId === "dead"),
    ).toBe(false);
  });

  it("lets a terminal keep a pid an agent also reaches", () => {
    const tree = run({ agents: [{ pid: 10, threadId: "t1" }] });
    expect(tree.projects[0]!.rows.map((row) => row.kind)).toEqual(["terminal"]);
  });

  it("names emulators from -avd, keeps the hub rest as tools, and sorts by usage", () => {
    const { devices } = run();
    expect(devices.map((device) => [device.label, device.platform, device.usage.rssBytes])).toEqual(
      [
        ["Pixel 8", "android", 2005],
        ["Device tools", "tools", 50],
      ],
    );
  });

  it("recognises the iOS simulator and skips devices without processes", () => {
    const ios = [p(50, [51], 1, 0, "node"), p(51, [], 700, 20, "Simulator")];
    const { devices } = run({ processes: ios, hubPids: [50, 60] });
    expect(devices.map((device) => [device.label, device.platform])).toEqual([
      ["iOS Simulator", "ios"],
      ["Device tools", "tools"],
    ]);
  });

  it("lists each row's processes once", () => {
    const tree = run();
    const rows = tree.projects.find((project) => project.projectKey === "A")!.rows;
    const pids = (owner: { processes: ReadonlyArray<ResourceTelemetryProcess> }) =>
      owner.processes.map((process) => process.identity.pid);
    expect(rows.map(pids)).toEqual([
      [11, 10],
      [21, 20],
    ]);
    expect(tree.devices.map(pids)).toEqual([
      [42, 41],
      [43, 40],
    ]);
    const all = [...rows, ...tree.devices].flatMap(pids);
    expect(new Set(all).size).toBe(all.length);
  });

  it.each([
    ["memory", [2, 3, 1]],
    ["cpu", [3, 1, 2]],
    ["name", [1, 3, 2]],
  ] as const)("sorts a row's processes by %s", (sort, expected) => {
    const processes = [
      p(1, [2, 3], 100, 5, "a", "zeta"),
      p(2, [], 900, 1, "node", "node /x/node_modules/vite/bin/vite.js"),
      p(3, [], 500, 80, "node", "node scripts/build.js"),
    ];
    const tree = run({
      processes,
      terminals: [{ key: "a", name: "a", threadId: "x", projectKey: "A", pid: 1 }],
      agents: [],
      hubPids: [],
      sort,
    });
    expect(tree.projects[0]!.rows[0]!.processes.map((process) => process.identity.pid)).toEqual(
      expected,
    );
  });

  it.each([
    ["memory", ["Project B", "Project A"]],
    ["cpu", ["Project A", "Project B"]],
    ["name", ["Project A", "Project B"]],
  ] as const)("orders projects by %s", (sort, expected) => {
    const processes = [p(1, [], 100, 9), p(2, [], 900, 1)];
    const tree = run({
      processes,
      terminals: [
        { key: "a", name: "a", threadId: "x", projectKey: "A", pid: 1 },
        { key: "b", name: "b", threadId: "y", projectKey: "B", pid: 2 },
      ],
      agents: [],
      hubPids: [],
      sort,
    });
    expect(tree.projects.map((project) => project.title)).toEqual(expected);
  });
});

describe("toMachineShare", () => {
  const aggregate = { currentCpuPercent: 300, currentRssBytes: 1, processCount: 2 };
  const snapshot = (cpuCount?: number) =>
    ({
      ...(cpuCount === undefined ? {} : { cpuCount }),
      processes: [proc(1, [], 10, 250)],
      groups: { backend: aggregate, electron: aggregate, monitor: aggregate, allT3: aggregate },
    }) as unknown as ResourceTelemetrySnapshot;

  it.each([
    ["ten cores", 10, 25, 30],
    ["one core", 1, 250, 300],
    ["an older server without a core count", undefined, 250, 300],
  ])("on %s shows CPU as a share of the machine", (_case, cores, process, allT3) => {
    const shared = toMachineShare(snapshot(cores));
    expect(shared.processes[0]?.cpuPercent).toBe(process);
    expect(shared.groups.allT3.currentCpuPercent).toBe(allT3);
  });

  it("returns the same object for the same snapshot", () => {
    const source = snapshot(10);
    expect(toMachineShare(source)).toBe(toMachineShare(source));
  });
});
