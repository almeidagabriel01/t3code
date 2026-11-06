import type { HeavyQueueEntry } from "@t3tools/contracts";

export interface HeavyQueueRow {
  readonly id: string;
  readonly running: boolean;
  /** 1-based place among the waiters; null for the running entry. */
  readonly position: number | null;
  readonly label: string;
  readonly subtitle: string;
  readonly startedAt: string | null;
  /** The first waiter is already next. */
  readonly canPromote: boolean;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

const folderName = (cwd: string) => cwd.split(/[\\/]/).findLast((part) => part !== "") ?? cwd;

export function buildHeavyQueueRows(
  entries: ReadonlyArray<HeavyQueueEntry>,
  threadTitle: (threadId: string) => string | undefined,
): ReadonlyArray<HeavyQueueRow> {
  let waiting = 0;
  return entries.map((entry) => {
    const running = entry.startedAt !== null;
    if (!running) waiting += 1;
    return {
      id: entry.id,
      running,
      position: running ? null : waiting,
      label: entry.label,
      subtitle:
        (entry.threadId === null ? undefined : threadTitle(entry.threadId)) ||
        folderName(entry.cwd),
      startedAt: entry.startedAt,
      canPromote: !running && waiting > 1,
    };
  });
}

export function formatElapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
