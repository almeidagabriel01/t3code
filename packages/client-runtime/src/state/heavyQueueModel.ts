import {
  heavyHoldText,
  type HeavyCommand,
  type HeavyQueueEntry,
  type HeavyQueueRule,
  type HeavyQueueState,
} from "@t3tools/contracts";

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

/** "Using 1.5 cores (9%) · 2.1 GB · peak 3.0 cores · 2.4 GB"; null when nothing was sampled yet. */
export function runningUsageLine(usage: RunningUsage, cpuCount: number | null): string | null {
  const parts: string[] = [];
  if (usage.cpu !== undefined && usage.memory !== undefined) {
    const share =
      cpuCount === null ? "" : ` (${Math.round((usage.cpu / Math.max(1, cpuCount)) * 100)}%)`;
    parts.push(`Using ${cores(usage.cpu)}${share} · ${gb(usage.memory)}`);
  }
  if (usage.peakCpu !== undefined && usage.peakMemory !== undefined) {
    parts.push(`peak ${cores(usage.peakCpu)} · ${gb(usage.peakMemory)}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** "Peak 3.0 cores · 2.4 GB"; null until a peak was sampled. */
export function peakUsageLine(usage: RunningUsage): string | null {
  return usage.peakCpu === undefined || usage.peakMemory === undefined
    ? null
    : `Peak ${cores(usage.peakCpu)} · ${gb(usage.peakMemory)}`;
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
      : `Usually ~${cores(usual.cpu)} · ${gb(usual.memoryBytes)} · ${usualTime(usual.durationMs)}`;
  }
  return runningUsageLine(entry, state.machine?.cpuCount ?? null);
}

export const HEAVY_COMMAND_SOURCE_LABEL: Record<HeavyCommand["source"], string> = {
  queue: "Queued",
  agent: "Agent",
  terminal: "Terminal",
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

/**
 * One line for the Mac's side of the queue: what holds its next job, in words drawn from the same
 * reading as the numbers beside them. Linux jobs and waiters have their own line.
 */
export function queueSummary(
  state: Pick<
    HeavyQueueState,
    "entries" | "enabled" | "paused" | "maxRunning" | "machine" | "hold" | "reasons" | "routes"
  >,
): string {
  if (!state.enabled) return QUEUE_OFF_SUMMARY;
  const running = state.entries.filter(
    (entry) => entry.startedAt !== null && entry.runner !== "linux",
  ).length;
  const head = `${running} of ${state.maxRunning} running`;
  const { machine, hold } = state;
  const reading =
    machine === null
      ? ""
      : ` · CPU ${Math.round((machine.busyCores / Math.max(1, machine.cpuCount)) * 100)}% · ${(machine.availableMemoryBytes / 1024 ** 3).toFixed(1)} GB free`;
  if (state.paused) return `${head} · paused${reading}`;
  const next = state.entries.find(
    (entry) => entry.startedAt === null && state.routes[entry.id] !== "linux",
  );
  const text =
    hold === null
      ? null
      : hold === "job-memory" || hold === "job-cpu"
        ? ((next === undefined ? undefined : state.reasons[next.id]) ?? null)
        : heavyHoldText(hold, machine, state.maxRunning);
  if (text !== null) return `${head} · ${next === undefined ? "" : "waiting: "}${text}${reading}`;
  // Without a reading there is nothing to back a claim about the Mac.
  return machine === null ? head : `${head} · Mac has room${reading}`;
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
