import type { ResourceTelemetryProcess } from "@t3tools/contracts";

export interface ResourceUsage {
  readonly rssBytes: number;
  readonly cpuPercent: number;
  readonly processCount: number;
}

export const EMPTY_USAGE: ResourceUsage = { rssBytes: 0, cpuPercent: 0, processCount: 0 };

export const addUsage = (a: ResourceUsage, b: ResourceUsage): ResourceUsage => ({
  rssBytes: a.rssBytes + b.rssBytes,
  cpuPercent: a.cpuPercent + b.cpuPercent,
  processCount: a.processCount + b.processCount,
});

export interface TerminalRoot {
  readonly key: string;
  /** Null when the terminal's thread has no known project. */
  readonly projectKey: string | null;
  readonly pid: number | null;
}

export interface AttributedUsage {
  readonly terminals: ReadonlyMap<string, ResourceUsage>;
  /** Terminals without a project land under `null`. */
  readonly projects: ReadonlyMap<string | null, ResourceUsage>;
  /** Pids a terminal subtree owns; the app breakdown leaves them out. */
  readonly claimed: ReadonlySet<number>;
}

/** Each process counts once: a pid already claimed by an earlier terminal adds nothing to a later one. */
export function attributeTerminalUsage(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  terminals: ReadonlyArray<TerminalRoot>,
): AttributedUsage {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const claimed = new Set<number>();
  const perTerminal = new Map<string, ResourceUsage>();
  const perProject = new Map<string | null, ResourceUsage>();

  for (const terminal of terminals) {
    let usage = EMPTY_USAGE;
    const pending = terminal.pid === null ? [] : [terminal.pid];
    while (pending.length > 0) {
      const pid = pending.pop()!;
      const process = byPid.get(pid);
      if (process === undefined || claimed.has(pid)) continue;
      claimed.add(pid);
      usage = addUsage(usage, {
        rssBytes: process.residentBytes,
        cpuPercent: process.cpuPercent,
        processCount: 1,
      });
      pending.push(...process.childPids);
    }
    perTerminal.set(terminal.key, usage);
    perProject.set(
      terminal.projectKey,
      addUsage(perProject.get(terminal.projectKey) ?? EMPTY_USAGE, usage),
    );
  }
  return { terminals: perTerminal, projects: perProject, claimed };
}

export type AppProcessGroup = "main" | "renderer" | "server" | "other";

const APP_GROUP_BY_CATEGORY: Partial<
  Record<ResourceTelemetryProcess["category"], AppProcessGroup>
> = {
  "electron-main": "main",
  "electron-renderer": "renderer",
  server: "server",
};

/** Processes no terminal claims, grouped as the desktop app, its renderers, the server, and the rest. */
export function appBreakdown(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  claimed: ReadonlySet<number>,
): ReadonlyMap<AppProcessGroup, ResourceUsage> {
  const groups = new Map<AppProcessGroup, ResourceUsage>();
  for (const process of processes) {
    if (claimed.has(process.identity.pid)) continue;
    const group = APP_GROUP_BY_CATEGORY[process.category] ?? "other";
    groups.set(
      group,
      addUsage(groups.get(group) ?? EMPTY_USAGE, {
        rssBytes: process.residentBytes,
        cpuPercent: process.cpuPercent,
        processCount: 1,
      }),
    );
  }
  return groups;
}
