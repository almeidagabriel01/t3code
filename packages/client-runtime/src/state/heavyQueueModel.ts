import {
  heavyHoldText,
  type HeavyCommand,
  type HeavyQueueEntry,
  type HeavyQueueHold,
  type HeavyQueueRule,
  type HeavyQueueState,
  type HeavyRunner,
  type HostResourcesSnapshot,
} from "@t3tools/contracts";

import { linuxLine, runnerBadge } from "./runnerModel.ts";

const trimRoot = (path: string) => path.replace(/[\\/]+$/, "");

/** The project whose folder holds `cwd`; the deepest folder wins, as the queue's own rules do. */
export function projectForCwd<P extends { readonly workspaceRoot: string }>(
  projects: ReadonlyArray<P>,
  cwd: string,
): P | undefined {
  let best: P | undefined;
  for (const project of projects) {
    const root = trimRoot(project.workspaceRoot);
    const inside = cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
    if (inside && (best === undefined || root.length > trimRoot(best.workspaceRoot).length)) {
      best = project;
    }
  }
  return best;
}

/** The rule covering `cwd`'s project, by the same deepest-folder match the queue applies. */
export function ruleForRoot(
  rules: ReadonlyArray<HeavyQueueRule>,
  root: string,
): HeavyQueueRule | undefined {
  return rules.find((rule) => trimRoot(rule.root) === trimRoot(root));
}

/** A job-menu priority change, and the `setPriority` input that makes it. */
export const PRIORITY_CHANGE = {
  "high-now": "high",
  normal: "high",
  lower: "low",
} as const satisfies Record<string, "low" | "high">;
export type PriorityChange = keyof typeof PRIORITY_CHANGE;

/**
 * The row's priority label and the changes its menu offers. A waiter can be released at once; a
 * running job shows and changes the CPU QoS it actually runs with, never its place in the queue.
 */
export function jobPriority(entry: HeavyQueueEntry): {
  readonly label: "Low priority" | null;
  readonly changes: ReadonlyArray<PriorityChange>;
} {
  if (entry.startedAt === null) {
    return { label: null, changes: entry.priority === "high" ? [] : ["high-now"] };
  }
  if (entry.qos === "background") return { label: "Low priority", changes: ["normal"] };
  return { label: null, changes: entry.qos === "normal" ? ["lower"] : [] };
}

export type MoveAction = "next" | "up" | "down" | "end";

/**
 * The `beforeId` for a move RPC, or undefined when the move would change nothing.
 * `null` means to the end; only waiting entries take part.
 */
export function moveTarget(
  entries: ReadonlyArray<HeavyQueueEntry>,
  id: string,
  action: MoveAction,
): string | null | undefined {
  const waiting = entries.filter((entry) => entry.startedAt === null);
  const index = waiting.findIndex((entry) => entry.id === id);
  if (index < 0) return undefined;
  switch (action) {
    case "next":
      return index === 0 ? undefined : waiting[0]!.id;
    case "up":
      return index === 0 ? undefined : waiting[index - 1]!.id;
    case "down":
      return index >= waiting.length - 1 ? undefined : (waiting[index + 2]?.id ?? null);
    case "end":
      return index >= waiting.length - 1 ? undefined : null;
  }
}

/** Where a drag-and-drop of `id` onto `overId` lands: before it when moving up, after it when moving down. */
export function dropTarget(
  entries: ReadonlyArray<HeavyQueueEntry>,
  id: string,
  overId: string,
): string | null | undefined {
  const waiting = entries.filter((entry) => entry.startedAt === null);
  const from = waiting.findIndex((entry) => entry.id === id);
  const to = waiting.findIndex((entry) => entry.id === overId);
  if (from < 0 || to < 0 || from === to) return undefined;
  return from > to ? overId : (waiting[to + 1]?.id ?? null);
}

export function formatDuration(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const GB = 1024 ** 3;
const cores = (n: number) => `${n.toFixed(1)} cores`;
const MB = 1024 ** 2;
// Below a gigabyte "0.0 GB" hides real usage, so small amounts read in megabytes.
const gb = (bytes: number) =>
  bytes < GB ? `${Math.max(1, Math.round(bytes / MB))} MB` : `${(bytes / GB).toFixed(1)} GB`;
const usualTime = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
};

interface RunningUsage {
  readonly cpu?: number | undefined;
  readonly memory?: number | undefined;
  readonly peakCpu?: number | undefined;
  readonly peakMemory?: number | undefined;
}

/** Tooltip on a CPU cell whose reading is unknown: the monitor could not see the job's processes. */
export const CPU_UNAVAILABLE = "CPU reading unavailable";

/**
 * A heavy row's usage columns: null before any sample, and a null CPU share when the sample read
 * the job's memory but not its CPU, which is unknown rather than idle.
 */
export function heavyRowUsage(
  usage: RunningUsage,
  cpuCount: number,
): { readonly cpuPercent: number | null; readonly rssBytes: number } | null {
  if (usage.memory === undefined) return null;
  return {
    cpuPercent: usage.cpu === undefined ? null : (usage.cpu / Math.max(1, cpuCount)) * 100,
    rssBytes: usage.memory,
  };
}

/**
 * "Using 1.5 cores (9%) · 2.1 GB · peak 3.0 cores · 2.4 GB", or "Using 2.1 GB · CPU unavailable"
 * when the CPU was not read; null when nothing was sampled yet.
 */
export function runningUsageLine(usage: RunningUsage, cpuCount: number | null): string | null {
  const parts: string[] = [];
  if (usage.memory !== undefined) {
    if (usage.cpu === undefined) {
      parts.push(`Using ${gb(usage.memory)} · CPU unavailable`);
    } else {
      const share =
        cpuCount === null ? "" : ` (${Math.round((usage.cpu / Math.max(1, cpuCount)) * 100)}%)`;
      parts.push(`Using ${cores(usage.cpu)}${share} · ${gb(usage.memory)}`);
    }
  }
  const peak = peakUsage(usage);
  if (peak !== null) parts.push(`peak ${peak}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

const peakUsage = (usage: RunningUsage) =>
  usage.peakMemory === undefined
    ? null
    : `${usage.peakCpu === undefined ? "" : `${cores(usage.peakCpu)} · `}${gb(usage.peakMemory)}`;

/** "Peak 3.0 cores · 2.4 GB", without cores when no sample read the CPU; null until a peak was sampled. */
export function peakUsageLine(usage: RunningUsage): string | null {
  const peak = peakUsage(usage);
  return peak === null ? null : `Peak ${peak}`;
}

/** One muted line of usage: a running job's current and peak, or a waiter's usual cost. Null when unknown. */
export function usageLine(
  entry: HeavyQueueEntry,
  state: Pick<HeavyQueueState, "estimates" | "machine">,
): string | null {
  if (entry.startedAt === null) {
    const usual = state.estimates?.[entry.id];
    return usual === undefined
      ? null
      : `Usually ~${usual.cpu === undefined ? "" : `${cores(usual.cpu)} · `}${gb(usual.memoryBytes)} · ${usualTime(usual.durationMs)}`;
  }
  return runningUsageLine(entry, state.machine?.cpuCount ?? null);
}

export const HEAVY_COMMAND_SOURCE_LABEL: Record<HeavyCommand["source"], string> = {
  queue: "Queued",
  agent: "Agent",
  terminal: "Terminal",
  detached: "Outside agents",
};

/** Stable across samples: the queue entry, else the root process's identity. */
export const heavyCommandKey = (command: HeavyCommand) =>
  command.entryId ?? `${command.pid}:${command.startTimeMs}`;

/** Its folder's project when known (queue rows), else its thread's project. */
export function projectForCommand<
  P extends { readonly id: string; readonly workspaceRoot: string },
>(
  command: Pick<HeavyCommand, "threadId"> & { readonly cwd?: string | undefined },
  projects: ReadonlyArray<P>,
  projectIdOfThread: (threadId: string) => string | undefined,
): P | undefined {
  const byFolder = command.cwd === undefined ? undefined : projectForCwd(projects, command.cwd);
  if (byFolder !== undefined) return byFolder;
  const id = command.threadId === null ? undefined : projectIdOfThread(command.threadId);
  return id === undefined ? undefined : projects.find((project) => project.id === id);
}

/** Queue entries or heavy commands that belong to `projectId`, by the same match their rows show. */
export function heavyItemsInProject<
  T extends Pick<HeavyCommand, "threadId"> & { readonly cwd?: string | undefined },
>(
  items: ReadonlyArray<T>,
  input: {
    readonly projectId: string;
    readonly projects: ReadonlyArray<{ readonly id: string; readonly workspaceRoot: string }>;
    readonly projectIdOfThread: (threadId: string) => string | undefined;
  },
): T[] {
  return items.filter(
    (item) =>
      projectForCommand(item, input.projects, input.projectIdOfThread)?.id === input.projectId,
  );
}

const QUEUE_OFF_SUMMARY = "Queue off: heavy jobs start right away";

/** One machine's side of the queue: its slots, its latest reading, and a note when it is not simply working. */
export interface MachineSummary {
  readonly running: number;
  readonly slots: number;
  /** Busy share of the machine's CPU, 0–100 on both; null without a reading. */
  readonly cpuPercent: number | null;
  /** Linux's one-minute load, a hint beside its CPU; null on the Mac or without a reading. */
  readonly load: number | null;
  readonly cpuCount: number | null;
  readonly freeBytes: number | null;
  /** Null while Linux has not been checked yet; the Mac is always online. */
  readonly online: boolean | null;
  /** The pause, what holds the next job, the queue being off, or Linux's trouble; null when healthy. */
  readonly note: string | null;
}

type SummaryState = Pick<
  HeavyQueueState,
  "entries" | "enabled" | "paused" | "maxRunning" | "machine" | "hold" | "reasons" | "routes"
> &
  Partial<Pick<HeavyQueueState, "linux">>;

function macSummary(state: SummaryState): MachineSummary {
  const { machine, hold } = state;
  const next = state.entries.find(
    (entry) => entry.startedAt === null && state.routes[entry.id] !== "linux",
  );
  const holdText =
    hold === null
      ? null
      : hold === "job-memory" || hold === "job-cpu"
        ? ((next === undefined ? undefined : state.reasons[next.id]) ?? null)
        : heavyHoldText(hold, machine, state.maxRunning);
  return {
    running: state.entries.filter((entry) => entry.startedAt !== null && entry.runner !== "linux")
      .length,
    slots: state.maxRunning,
    cpuPercent:
      machine === null
        ? null
        : Math.round((machine.busyCores / Math.max(1, machine.cpuCount)) * 100),
    load: null,
    cpuCount: machine?.cpuCount ?? null,
    freeBytes: machine?.availableMemoryBytes ?? null,
    online: true,
    note: !state.enabled
      ? QUEUE_OFF_SUMMARY
      : state.paused
        ? "paused"
        : holdText === null
          ? null
          : `${next === undefined ? "" : "waiting: "}${holdText}`,
  };
}

/** Both machines' summaries; `linux` is null while the Runner is off. */
export function machineSummaries(state: SummaryState): {
  readonly mac: MachineSummary;
  readonly linux: MachineSummary | null;
} {
  const { linux } = state;
  return {
    mac: macSummary(state),
    linux:
      linux === null || linux === undefined
        ? null
        : {
            running: linux.running,
            slots: linux.slots,
            cpuPercent: linux.cpuPercent ?? null,
            load: linux.load1,
            cpuCount: linux.cpuCount,
            freeBytes: linux.availableMemoryBytes,
            online: linux.online,
            note:
              linux.online !== true
                ? linuxLine(linux)
                : state.enabled && state.paused
                  ? "paused"
                  : null,
          },
  };
}

/** The Mac gauge a hold is about; the rest hold the slots, so they show on those. */
const HOLD_GAUGE: Record<HeavyQueueHold, "cpu" | "memory" | null> = {
  paused: null,
  exclusive: null,
  "runs-alone": null,
  slots: null,
  settling: null,
  "no-reading": null,
  steadying: null,
  pressure: "memory",
  "swap-in": "memory",
  "memory-floor": "memory",
  "job-memory": "memory",
  cpu: "cpu",
  "job-cpu": "cpu",
};

/** Which Mac gauge the Mac's note warns on, or null when the note (if any) is about its slots. */
export function macNoteGauge(
  state: Pick<HeavyQueueState, "enabled" | "paused" | "hold">,
): "cpu" | "memory" | null {
  return !state.enabled || state.paused || state.hold === null ? null : HOLD_GAUGE[state.hold];
}

/** One machine's share of the heavy work, running first and then waiting in its line's order. */
export interface MachineWork {
  readonly running: ReadonlyArray<HeavyQueueEntry>;
  /** Heavy commands agents and terminals run directly, which no queue entry covers. */
  readonly direct: ReadonlyArray<HeavyCommand>;
  readonly waiting: ReadonlyArray<HeavyQueueEntry>;
}

/**
 * The queue's entries and the heavy commands feed, merged with each job listed once. The feed
 * repeats every started entry as a `queue` command and samples apart from the queue's own pushes,
 * so the entries alone stand for queue jobs, and a direct command on a running entry's pid is that
 * job seen before the queue claimed it. Detached commands run outside T3 and come back apart.
 */
export function heavyWork(
  state: Pick<HeavyQueueState, "entries" | "linux" | "routes">,
  commands: ReadonlyArray<HeavyCommand>,
): {
  readonly mac: MachineWork;
  readonly linux: MachineWork;
  readonly detached: ReadonlyArray<HeavyCommand>;
} {
  const machineOf = (entry: HeavyQueueEntry): HeavyRunner =>
    runnerBadge(entry, state)?.runner ?? "mac";
  const of = (runner: HeavyRunner, started: boolean) =>
    state.entries.filter(
      (entry) => (entry.startedAt !== null) === started && machineOf(entry) === runner,
    );
  const jobPids = new Set(
    state.entries.flatMap((entry) =>
      entry.startedAt !== null && entry.server !== true ? [entry.pid] : [],
    ),
  );
  return {
    mac: {
      running: of("mac", true),
      direct: commands.filter(
        (command) =>
          (command.source === "agent" || command.source === "terminal") &&
          !jobPids.has(command.pid),
      ),
      waiting: of("mac", false),
    },
    linux: { running: of("linux", true), direct: [], waiting: of("linux", false) },
    detached: commands.filter((command) => command.source === "detached"),
  };
}

/** Every row of the heavy work, both machines: what its count and a project's share count. */
export const heavyWorkItems = (work: ReturnType<typeof heavyWork>) => [
  ...work.mac.running,
  ...work.mac.direct,
  ...work.mac.waiting,
  ...work.linux.running,
  ...work.linux.waiting,
];

/** "3.4 GB", as the queue's lines print free memory; "420 MB" below a gigabyte, never "0.0 GB". */
export const formatFreeMemory = gb;

/** One gauge of a machine: how full it is, its value, and the exact words behind it. */
export interface MachineGauge {
  readonly share: number | null;
  readonly value: string;
  /** A condition holding the queue is about this gauge; `hint` then names it. */
  readonly warn: boolean;
  readonly hint: string;
}

/** One machine of the machine bar. */
export interface MachineBarRow {
  readonly runner: HeavyRunner;
  /** Linux's connection, null while it is being checked; always true for the Mac. */
  readonly online: boolean | null;
  readonly statusHint: string | null;
  /** Both null while Linux is not online; `offline` then says so. */
  readonly cpu: MachineGauge | null;
  readonly memory: MachineGauge | null;
  readonly offline: { readonly text: string; readonly hint: string } | null;
  /** Null on the Mac while the queue is off; `queueOff` then holds its note. */
  readonly slots: {
    readonly running: number;
    readonly slots: number;
    readonly hint: string;
  } | null;
  readonly queueOff: string | null;
}

const NO_GAUGE = (hint: string): MachineGauge => ({ share: null, value: "--", warn: false, hint });
const withWarning = (text: string, warning: string | null) =>
  warning === null ? text : `${text} · ${warning}`;

/**
 * This Mac's CPU (share of the machine, in percent) and used memory, as the machine bar shows them:
 * the queue's own sample when it has one, `host` otherwise. Null where neither has a reading.
 */
export function macReading(
  state: HeavyQueueState,
  host: HostResourcesSnapshot | null | undefined,
): { readonly cpuPercent: number | null; readonly usedBytes: number | null } {
  const { machine } = state;
  const memory = machine ?? host ?? null;
  return {
    cpuPercent:
      machine !== null
        ? (machine.busyCores / Math.max(1, machine.cpuCount)) * 100
        : host?.cpuUtilization == null
          ? null
          : host.cpuUtilization * 100,
    usedBytes:
      memory === null || memory.totalMemoryBytes <= 0
        ? null
        : memory.totalMemoryBytes - memory.availableMemoryBytes,
  };
}

/**
 * This Mac and, while the Runner reports it, Linux. The Mac reads the queue's own sample when it
 * has one, so a warning always matches the number beside it, and `host` otherwise. Running counts
 * come from `heavyWork`, the same split the rows use. `hostFailed` marks a host read that failed
 * with nothing earlier to show.
 */
export function machineBar(
  state: HeavyQueueState,
  host: HostResourcesSnapshot | null | undefined,
  hostFailed = false,
): { readonly mac: MachineBarRow; readonly linux: MachineBarRow | null } {
  const { machine, linux } = state;
  const cpuPercent = macReading(state, host).cpuPercent;
  const cpu =
    cpuPercent === null
      ? null
      : {
          percent: cpuPercent,
          detail:
            machine !== null
              ? `${machine.busyCores.toFixed(1)} of ${machine.cpuCount} cores busy`
              : `${host?.cpuCount} cores`,
        };
  const memory = machine ?? host ?? null;
  const work = heavyWork(state, []);
  const note = machineSummaries(state).mac.note;
  const gauge = macNoteGauge(state);
  const warning = (on: "cpu" | "memory") => (gauge === on && note !== null ? note : null);
  const cpuWarning = warning("cpu");
  const memoryWarning = warning("memory");
  const macRunning = work.mac.running.length;
  const mac: MachineBarRow = {
    runner: "mac",
    online: true,
    statusHint: null,
    cpu:
      cpu === null
        ? NO_GAUGE(hostFailed ? "CPU reading failed" : "No CPU reading yet")
        : {
            share: cpu.percent / 100,
            value: `${Math.round(cpu.percent)}%`,
            warn: cpuWarning !== null,
            hint: withWarning(`CPU ${Math.round(cpu.percent)}% · ${cpu.detail}`, cpuWarning),
          },
    memory:
      memory === null
        ? NO_GAUGE(hostFailed ? "Memory reading failed" : "No memory reading yet")
        : {
            share:
              memory.totalMemoryBytes <= 0
                ? null
                : 1 - memory.availableMemoryBytes / memory.totalMemoryBytes,
            value: gb(memory.availableMemoryBytes),
            warn: memoryWarning !== null,
            hint: withWarning(
              `${gb(memory.availableMemoryBytes)} free of ${gb(memory.totalMemoryBytes)}`,
              memoryWarning,
            ),
          },
    offline: null,
    slots: state.enabled
      ? {
          running: macRunning,
          slots: state.maxRunning,
          hint: withWarning(
            `${macRunning} of ${state.maxRunning} running on this Mac`,
            gauge === null ? note : null,
          ),
        }
      : null,
    queueOff: state.enabled ? null : (note ?? ""),
  };
  if (linux === null) return { mac, linux: null };
  const linuxRunning = work.linux.running.length;
  const live = linux.online === true;
  const cores = linux.cpuCount;
  return {
    mac,
    linux: {
      runner: "linux",
      online: linux.online,
      statusHint: live ? `${linux.host} · online` : linuxLine(linux),
      cpu: !live
        ? null
        : linux.cpuPercent === undefined || linux.cpuPercent === null
          ? NO_GAUGE("No CPU reading yet")
          : {
              share: linux.cpuPercent / 100,
              value: `${Math.round(linux.cpuPercent)}%`,
              warn: false,
              hint: `${Math.round(linux.cpuPercent)}% CPU in use${linux.load1 === null ? "" : ` · load ${linux.load1.toFixed(1)}${cores === null ? "" : ` on ${cores} cores`}`}`,
            },
      memory: !live
        ? null
        : linux.availableMemoryBytes === null
          ? NO_GAUGE("No memory reading yet")
          : {
              share:
                linux.totalMemoryBytes === null || linux.totalMemoryBytes <= 0
                  ? null
                  : 1 - linux.availableMemoryBytes / linux.totalMemoryBytes,
              value: gb(linux.availableMemoryBytes),
              warn: false,
              hint: `${gb(linux.availableMemoryBytes)} free${linux.totalMemoryBytes === null ? "" : ` of ${gb(linux.totalMemoryBytes)}`}`,
            },
      offline: live
        ? null
        : { text: linux.online === false ? "Offline" : "Checking…", hint: linuxLine(linux) },
      slots: {
        running: linuxRunning,
        slots: linux.slots,
        hint: `${linuxRunning} of ${linux.slots} running on Linux${state.enabled && state.paused ? " · paused" : ""}`,
      },
      queueOff: null,
    },
  };
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

const LABEL_CHARS = 90;

/** A command line a person can scan: the program's file name, not its full path, and a bounded length. */
export function readableLabel(label: string): string {
  const [program = "", ...rest] = label.trim().split(/\s+/);
  const name = program.split(/[\\/]/).findLast((part) => part !== "") ?? program;
  const text = [name, ...rest].join(" ");
  return text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text;
}

type QueuePriority = "first" | "normal" | "last";

export const PRIORITY_LABEL: Record<QueuePriority, string> = {
  first: "Always first",
  normal: "Normal",
  last: "Last",
};
