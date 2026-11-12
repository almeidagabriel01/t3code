import type {
  DeviceShutdownInput,
  DeviceSummary,
  ResourceTelemetryAggregate,
  ResourceTelemetryProcess,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";

import { keepOrder } from "../../hooks/useOrderWhileOpen";
import { processLabel } from "./processLabel.logic";

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

export interface UsageRoot {
  readonly key: string;
  readonly pid: number | null;
}

/** Each process counts once: a pid an earlier root claimed adds nothing to a later one. */
function claimUsage(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  roots: ReadonlyArray<UsageRoot>,
  claimed: Set<number> = new Set(),
): {
  readonly usage: ReadonlyMap<string, ResourceUsage>;
  readonly processes: ReadonlyMap<string, ReadonlyArray<ResourceTelemetryProcess>>;
} {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const perRoot = new Map<string, ResourceUsage>();
  const processesPerRoot = new Map<string, ResourceTelemetryProcess[]>();
  for (const root of roots) {
    let usage = EMPTY_USAGE;
    const owned: ResourceTelemetryProcess[] = [];
    const pending = root.pid === null ? [] : [root.pid];
    while (pending.length > 0) {
      const pid = pending.pop()!;
      const process = byPid.get(pid);
      if (process === undefined || claimed.has(pid)) continue;
      claimed.add(pid);
      owned.push(process);
      usage = addUsage(usage, {
        rssBytes: process.residentBytes,
        cpuPercent: process.cpuPercent,
        processCount: 1,
      });
      pending.push(...process.childPids);
    }
    perRoot.set(root.key, usage);
    processesPerRoot.set(root.key, owned);
  }
  return { usage: perRoot, processes: processesPerRoot };
}

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

export function attributeTerminalUsage(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  terminals: ReadonlyArray<TerminalRoot>,
): AttributedUsage {
  const claimed = new Set<number>();
  const perTerminal = claimUsage(processes, terminals, claimed).usage;
  const perProject = new Map<string | null, ResourceUsage>();
  for (const terminal of terminals) {
    perProject.set(
      terminal.projectKey,
      addUsage(perProject.get(terminal.projectKey) ?? EMPTY_USAGE, perTerminal.get(terminal.key)!),
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

const compareProcesses =
  (sort: ResourceSort) => (left: ResourceTelemetryProcess, right: ResourceTelemetryProcess) =>
    sort === "name"
      ? processLabel(left).localeCompare(processLabel(right))
      : sort === "cpu"
        ? right.cpuPercent - left.cpuPercent
        : right.residentBytes - left.residentBytes;

export interface AppGroupRow {
  readonly group: AppProcessGroup;
  readonly usage: ResourceUsage;
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
}

const APP_GROUP_ORDER: ReadonlyArray<AppProcessGroup> = ["main", "renderer", "server", "other"];

/** Processes no terminal claims, grouped as the desktop app, its renderers, the server, and the rest. */
export function appBreakdown(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  claimed: ReadonlySet<number>,
  sort: ResourceSort = "memory",
): ReadonlyArray<AppGroupRow> {
  const groups = new Map<AppProcessGroup, ResourceTelemetryProcess[]>();
  for (const process of processes) {
    if (claimed.has(process.identity.pid) || process.category === "external-device") continue;
    const group = APP_GROUP_BY_CATEGORY[process.category] ?? "other";
    groups.set(group, [...(groups.get(group) ?? []), process]);
  }
  return APP_GROUP_ORDER.flatMap((group) => {
    const members = groups.get(group);
    if (members === undefined) return [];
    return [
      {
        group,
        usage: members.reduce(
          (sum, process) =>
            addUsage(sum, {
              rssBytes: process.residentBytes,
              cpuPercent: process.cpuPercent,
              processCount: 1,
            }),
          EMPTY_USAGE,
        ),
        processes: members.toSorted(compareProcesses(sort)),
      },
    ];
  });
}

export type ResourceSort = "name" | "cpu" | "memory";

export interface TreeTerminal {
  readonly key: string;
  readonly name: string;
  readonly threadId: string;
  readonly projectKey: string | null;
  readonly pid: number | null;
}

export interface TreeAgent {
  readonly pid: number;
  readonly threadId: string;
}

export type ProjectRow =
  | {
      readonly kind: "terminal";
      readonly key: string;
      readonly name: string;
      readonly threadId: string;
      readonly usage: ResourceUsage;
      readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
    }
  | {
      readonly kind: "agent";
      readonly key: string;
      readonly name: string;
      readonly threadId: string;
      readonly usage: ResourceUsage;
      readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
    };

export interface ProjectNode {
  readonly projectKey: string | null;
  readonly title: string;
  readonly usage: ResourceUsage;
  readonly rows: ReadonlyArray<ProjectRow>;
}

export type DevicePlatform = "android" | "ios" | "tools";

export interface DeviceRow {
  readonly key: string;
  readonly label: string;
  readonly platform: DevicePlatform;
  /** The AVD an Android row runs; the device list names booted emulators by it. */
  readonly avd: string | null;
  /** The simulator an iOS row runs, the id the device list gives it. */
  readonly udid: string | null;
  /** Runs outside T3's process tree, so the T3 total leaves it out. */
  readonly outside: boolean;
  readonly usage: ResourceUsage;
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
}

export interface ResourceTree {
  readonly projects: ReadonlyArray<ProjectNode>;
  readonly devices: ReadonlyArray<DeviceRow>;
  readonly app: ReadonlyArray<AppGroupRow>;
}

const processKey = (owner: string) => (process: ResourceTelemetryProcess) =>
  `process:${owner}:${process.identity.pid}`;
const projectKey = (project: ProjectNode) => `project:${project.projectKey}`;
const rowKey = (row: ProjectRow) => `row:${row.key}`;
const deviceKey = (device: DeviceRow) => `device:${device.key}`;
const appKey = (row: AppGroupRow) => `app:${row.group}`;

/** Every list entry of the tree, keyed by kind and owner, so one order can hold them all. */
export function resourceTreeKeys(tree: ResourceTree): string[] {
  return [
    ...tree.projects.flatMap((project) => [
      projectKey(project),
      ...project.rows.flatMap((row) => [
        rowKey(row),
        ...row.processes.map(processKey(rowKey(row))),
      ]),
    ]),
    ...tree.devices.flatMap((device) => [
      deviceKey(device),
      ...device.processes.map(processKey(deviceKey(device))),
    ]),
    ...tree.app.flatMap((row) => [appKey(row), ...row.processes.map(processKey(appKey(row)))]),
  ];
}

/** `tree` with every list in `order`; entries `order` lacks follow in their sorted place. */
export function orderResourceTree(tree: ResourceTree, order: ReadonlyArray<string>): ResourceTree {
  const ordered = <T>(items: ReadonlyArray<T>, key: (item: T) => string) =>
    keepOrder(items, order, key);
  const withProcesses = <T extends { readonly processes: ReadonlyArray<ResourceTelemetryProcess> }>(
    item: T,
    owner: string,
  ): T => ({ ...item, processes: ordered(item.processes, processKey(owner)) });
  return {
    projects: ordered(tree.projects, projectKey).map((project) => ({
      ...project,
      rows: ordered(project.rows, rowKey).map((row) => withProcesses(row, rowKey(row))),
    })),
    devices: ordered(tree.devices, deviceKey).map((device) =>
      withProcesses(device, deviceKey(device)),
    ),
    app: ordered(tree.app, appKey).map((row) => withProcesses(row, appKey(row))),
  };
}

const EMULATOR_AVD = /(?:^|\s)-avd[ =](\S+)/;
const isEmulatorProcess = (process: ResourceTelemetryProcess) =>
  /emulator|qemu-system/i.test(process.name) && EMULATOR_AVD.test(process.command);

const humanizeAvd = (avd: string) => avd.replaceAll("_", " ");
const SIMULATOR_UDID = /\/CoreSimulator\/Devices\/([0-9A-F-]{36})\//i;
const SIMULATOR_APP = "Simulator app";

type DeviceRoot = Omit<DeviceRow, "usage" | "processes"> & { readonly pid: number };

/** Topmost processes outside T3's tree: one per booted simulator, the Simulator app, emulators. */
function outsideDeviceRoots(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
): ReadonlyArray<DeviceRoot> {
  const outside = processes.filter((process) => process.category === "external-device");
  const children = new Set(outside.flatMap((process) => process.childPids));
  return outside.flatMap((process): DeviceRoot[] => {
    const pid = process.identity.pid;
    if (children.has(pid)) return [];
    const base = { avd: null, udid: null, outside: true, pid };
    const udid =
      process.name === "launchd_sim" ? SIMULATOR_UDID.exec(process.command)?.[1] : undefined;
    if (udid !== undefined) {
      return [
        { ...base, key: `outside:ios:${udid}`, label: "iOS Simulator", platform: "ios", udid },
      ];
    }
    if (process.name === "Simulator") {
      return [{ ...base, key: `outside:simulator:${pid}`, label: SIMULATOR_APP, platform: "ios" }];
    }
    const avd = isEmulatorProcess(process) ? EMULATOR_AVD.exec(process.command)?.[1] : undefined;
    if (avd !== undefined) {
      const key = `outside:android:${avd}`;
      return [{ ...base, key, label: humanizeAvd(avd), platform: "android", avd }];
    }
    return [];
  });
}

/** Emulators and the iOS Simulator the device hub started, then what is left of the hub itself. */
function deviceRoots(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  hubPids: ReadonlyArray<number>,
): ReadonlyArray<DeviceRoot> {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const roots: DeviceRoot[] = [];
  const seen = new Set<number>();
  for (const hubPid of hubPids) {
    const pending = [hubPid];
    while (pending.length > 0) {
      const pid = pending.pop()!;
      const process = byPid.get(pid);
      if (process === undefined || seen.has(pid)) continue;
      seen.add(pid);
      const avd = isEmulatorProcess(process) ? EMULATOR_AVD.exec(process.command)?.[1] : undefined;
      if (avd !== undefined) {
        // The launcher forwards to qemu: the topmost match owns the pair.
        roots.push({
          key: `android:${avd}`,
          label: humanizeAvd(avd),
          platform: "android",
          avd,
          udid: null,
          outside: false,
          pid,
        });
        continue;
      }
      if (process.name === "Simulator") {
        roots.push({
          key: `ios:${pid}`,
          label: SIMULATOR_APP,
          platform: "ios",
          avd: null,
          udid: null,
          outside: false,
          pid,
        });
        continue;
      }
      pending.push(...process.childPids);
    }
  }
  return [
    ...roots,
    ...hubPids.map((pid) => ({
      key: `tools:${pid}`,
      label: "Device tools",
      platform: "tools" as const,
      avd: null,
      udid: null,
      outside: false,
      pid,
    })),
    ...outsideDeviceRoots(processes),
  ];
}

const compareUsage =
  (sort: ResourceSort) =>
  (left: ResourceUsage, right: ResourceUsage, leftName: string, rightName: string) =>
    sort === "name"
      ? leftName.localeCompare(rightName)
      : sort === "cpu"
        ? right.cpuPercent - left.cpuPercent
        : right.rssBytes - left.rssBytes;

/**
 * Terminals claim their subtree first, then agents, then devices: a process counts once, so
 * work a terminal started never also shows under the agent.
 */
export function buildResourceTree(input: {
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly terminals: ReadonlyArray<TreeTerminal>;
  readonly agents: ReadonlyArray<TreeAgent>;
  readonly hubPids: ReadonlyArray<number>;
  readonly sort: ResourceSort;
  readonly projectOfThread: (threadId: string) => string | null;
  readonly projectTitle: (projectKey: string | null) => string;
  readonly threadTitle: (threadId: string) => string;
}): ResourceTree {
  const { processes, sort } = input;
  const claimed = new Set<number>();
  const terminalClaim = claimUsage(processes, input.terminals, claimed);
  const agentClaim = claimUsage(
    processes,
    input.agents.map((agent) => ({ key: agent.threadId, pid: agent.pid })),
    claimed,
  );
  const deviceList = deviceRoots(processes, input.hubPids);
  const deviceClaim = claimUsage(processes, deviceList, claimed);
  const compareProcess = compareProcesses(sort);
  const sortedProcesses = (claim: ReturnType<typeof claimUsage>, key: string) =>
    (claim.processes.get(key) ?? []).toSorted(compareProcess);

  const rowsByProject = new Map<string | null, ProjectRow[]>();
  const push = (projectKey: string | null, row: ProjectRow) =>
    rowsByProject.set(projectKey, [...(rowsByProject.get(projectKey) ?? []), row]);
  for (const terminal of input.terminals) {
    push(terminal.projectKey, {
      kind: "terminal",
      key: terminal.key,
      name: terminal.name,
      threadId: terminal.threadId,
      usage: terminalClaim.usage.get(terminal.key) ?? EMPTY_USAGE,
      processes: sortedProcesses(terminalClaim, terminal.key),
    });
  }
  for (const agent of input.agents) {
    const usage = agentClaim.usage.get(agent.threadId) ?? EMPTY_USAGE;
    if (usage.processCount === 0) continue;
    push(input.projectOfThread(agent.threadId), {
      kind: "agent",
      key: `agent:${agent.threadId}`,
      name: input.threadTitle(agent.threadId),
      threadId: agent.threadId,
      usage,
      processes: sortedProcesses(agentClaim, agent.threadId),
    });
  }

  const compare = compareUsage(sort);
  const projects = [...rowsByProject].map(([projectKey, rows]): ProjectNode => {
    const ordered = rows.toSorted((a, b) => compare(a.usage, b.usage, a.name, b.name));
    return {
      projectKey,
      title: input.projectTitle(projectKey),
      usage: ordered.reduce((sum, row) => addUsage(sum, row.usage), EMPTY_USAGE),
      rows: ordered,
    };
  });
  projects.sort((a, b) => compare(a.usage, b.usage, a.title, b.title));

  const devices = deviceList
    .map(({ pid: _pid, ...device }): DeviceRow => ({
      ...device,
      usage: deviceClaim.usage.get(device.key) ?? EMPTY_USAGE,
      processes: sortedProcesses(deviceClaim, device.key),
    }))
    .filter((device) => device.usage.processCount > 0)
    .toSorted((a, b) => compare(a.usage, b.usage, a.label, b.label));

  return { projects, devices, app: appBreakdown(processes, claimed, sort) };
}

/**
 * The booted device a row's processes run, on hosts of this machine: an emulator by its AVD, a
 * simulator by its id. The Simulator app and tools rows shut nothing.
 */
export function deviceShutdownTargets(
  row: Pick<DeviceRow, "platform" | "avd" | "udid">,
  devices: ReadonlyArray<DeviceSummary>,
  localHostIds: ReadonlySet<string>,
): ReadonlyArray<DeviceShutdownInput> {
  return devices
    .filter(
      (device) =>
        device.booted &&
        !device.physical &&
        localHostIds.has(device.hostId) &&
        device.platform === row.platform &&
        ((row.platform === "ios" && device.id === row.udid) ||
          (row.platform === "android" && device.name === row.avd)),
    )
    .map((device) => ({ hostId: device.hostId, deviceId: device.id, platform: device.platform }));
}

/** A simulator row takes the name this machine's device list gives it, such as "iPhone 17 Pro". */
export function deviceRowLabel(
  row: Pick<DeviceRow, "label" | "udid">,
  devices: ReadonlyArray<DeviceSummary>,
  localHostIds: ReadonlySet<string>,
): string {
  if (row.udid === null) return row.label;
  return (
    devices.find((device) => device.id === row.udid && localHostIds.has(device.hostId))?.name ??
    row.label
  );
}

const machineShares = new WeakMap<ResourceTelemetrySnapshot, ResourceTelemetrySnapshot>();

/**
 * The snapshot with CPU as a share of the whole machine (100% = every core busy), like the menu
 * bar meters. The server counts 100% per core; an older server without `cpuCount` stays per core.
 */
export function toMachineShare(snapshot: ResourceTelemetrySnapshot): ResourceTelemetrySnapshot {
  const cores = snapshot.cpuCount ?? 1;
  if (cores <= 1) return snapshot;
  const cached = machineShares.get(snapshot);
  if (cached) return cached;
  const group = (aggregate: ResourceTelemetryAggregate): ResourceTelemetryAggregate => ({
    ...aggregate,
    currentCpuPercent: aggregate.currentCpuPercent / cores,
  });
  const shared: ResourceTelemetrySnapshot = {
    ...snapshot,
    processes: snapshot.processes.map((process) => ({
      ...process,
      cpuPercent: process.cpuPercent / cores,
    })),
    groups: {
      backend: group(snapshot.groups.backend),
      electron: group(snapshot.groups.electron),
      monitor: group(snapshot.groups.monitor),
      allT3: group(snapshot.groups.allT3),
    },
  };
  machineShares.set(snapshot, shared);
  return shared;
}
