import type { HeavyQueueEntry, HeavyQueueRule, HeavyQueueState } from "@t3tools/contracts";

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
const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;
const usualTime = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
};

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
  const parts: string[] = [];
  if (entry.cpu !== undefined && entry.memory !== undefined) {
    const share =
      state.machine === null
        ? ""
        : ` (${Math.round((entry.cpu / Math.max(1, state.machine.cpuCount)) * 100)}%)`;
    parts.push(`Using ${cores(entry.cpu)}${share} · ${gb(entry.memory)}`);
  }
  if (entry.peakCpu !== undefined && entry.peakMemory !== undefined) {
    parts.push(`peak ${cores(entry.peakCpu)} · ${gb(entry.peakMemory)}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** "2 of 3 running · Mac has room": what the queue is doing at a glance. */
export function queueSummary(
  state: Pick<HeavyQueueState, "entries" | "paused" | "maxRunning" | "room" | "machine">,
): string {
  const running = state.entries.filter((entry) => entry.startedAt !== null).length;
  const head = `${running} of ${state.maxRunning} running`;
  const { machine } = state;
  const reading =
    machine === null
      ? ""
      : ` · CPU ${Math.round((machine.busyCores / Math.max(1, machine.cpuCount)) * 100)}% · ${(machine.availableMemoryBytes / 1024 ** 3).toFixed(1)} GB free`;
  if (state.paused) return `${head} · paused${reading}`;
  // Without a reading there is nothing to back a claim about the Mac.
  if (state.room && machine === null) return head;
  return `${head} · ${state.room ? "Mac has room" : "waiting for headroom"}${reading}`;
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
