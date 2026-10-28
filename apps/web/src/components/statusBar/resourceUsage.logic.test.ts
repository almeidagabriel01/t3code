import type { ResourceTelemetryProcess } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { appBreakdown, attributeTerminalUsage } from "./resourceUsage.logic";

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
  it("leaves out claimed processes", () => {
    const { claimed } = attributeTerminalUsage(processes, [{ key: "a", projectKey: "p", pid: 10 }]);
    const groups = appBreakdown(processes, claimed);
    expect(groups.get("main")?.rssBytes).toBe(100);
    expect(groups.get("renderer")?.rssBytes).toBe(50);
    expect(groups.get("server")?.rssBytes).toBe(10);
    expect(groups.get("other")).toEqual({ rssBytes: 7, cpuPercent: 3, processCount: 1 });
  });
});
