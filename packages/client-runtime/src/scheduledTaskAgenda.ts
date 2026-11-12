// @effect-diagnostics globalDate:off - Local calendar-day boundaries for a client agenda, outside an Effect runtime.
import type { ScheduledTask } from "@t3tools/contracts";

const DAY_MS = 86_400_000;
const MIN_INTERVAL_MS = 60_000;
/** More runs than this in one day collapse into a single block. */
const AGENDA_MAX_BLOCKS_PER_DAY = 3;

/** One block in a day column: a single run, or `runs` runs of a frequent task starting at `at`. */
export interface AgendaEntry {
  readonly task: ScheduledTask;
  readonly at: number;
  readonly runs: number;
  /** The task's last run, shown on today's column with its outcome. */
  readonly past: boolean;
}

export interface AgendaDay {
  readonly start: number;
  readonly entries: ReadonlyArray<AgendaEntry>;
}

/** Local midnights of `days` consecutive days from `now`'s day, plus the end of the last day. */
export function localDayStarts(now: number, days: number): number[] {
  const starts: number[] = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + offset);
    starts.push(day.getTime());
  }
  return starts;
}

const parse = (iso: string | null): number | null => {
  if (iso === null) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

/** Paused, blocked, webhook and finished tasks have nothing upcoming. */
export function scheduledTaskIsUpcoming(task: ScheduledTask): boolean {
  return (
    task.enabled &&
    task.blockedByPolicy === undefined &&
    task.schedule.type !== "webhook" &&
    parse(task.nextRunAt) !== null
  );
}

/** Runs of `task` in [from, to), at most `limit`, anchored on the server's next run. */
function runsBetween(task: ScheduledTask, from: number, to: number, limit: number): number[] {
  const anchor = parse(task.nextRunAt);
  if (anchor === null || limit <= 0) return [];
  const schedule = task.schedule;
  switch (schedule.type) {
    case "webhook":
      return [];
    case "once":
      return anchor >= from && anchor < to ? [anchor] : [];
    case "interval":
      return stepRuns(anchor, Math.max(schedule.everyMs, MIN_INTERVAL_MS), from, to, limit);
    case "fixed_time": {
      // ponytail: steps whole days from the server-computed run and filters weekdays in the
      // viewer's zone; a viewer in another zone than the server can see weekday edges shift.
      const weekdays = schedule.weekdays ?? [];
      return stepRuns(anchor, DAY_MS, from, to, Number.POSITIVE_INFINITY)
        .filter((at) => weekdays.length === 0 || weekdays.includes(new Date(at).getDay()))
        .slice(0, limit);
    }
  }
}

function stepRuns(anchor: number, step: number, from: number, to: number, limit: number) {
  const first = Math.max(0, Math.ceil((from - anchor) / step));
  const runs: number[] = [];
  for (let index = first; runs.length < limit; index += 1) {
    const at = anchor + index * step;
    if (at >= to) break;
    runs.push(at);
  }
  return runs;
}

const byTime = (a: AgendaEntry, b: AgendaEntry) =>
  a.at - b.at || a.task.title.localeCompare(b.task.title);

/**
 * Day columns for `dayStarts` (from `localDayStarts`): upcoming runs from `now`, plus today's
 * last run. Runs left under `maxRuns` are spent day by day, so a capped task stops showing.
 */
export function scheduledTaskAgenda(
  tasks: ReadonlyArray<ScheduledTask>,
  now: number,
  dayStarts: ReadonlyArray<number>,
): AgendaDay[] {
  const days = dayStarts.slice(0, -1).map((start, index) => {
    const end = dayStarts[index + 1]!;
    return { start, end, entries: [] as AgendaEntry[] };
  });
  for (const task of tasks) {
    const lastRun = parse(task.lastRunAt);
    const today = days[0];
    if (today && lastRun !== null && lastRun >= today.start && lastRun <= now) {
      today.entries.push({ task, at: lastRun, runs: 1, past: true });
    }
    if (!scheduledTaskIsUpcoming(task)) continue;
    let remaining =
      task.maxRuns === undefined || task.maxRuns === null
        ? Number.POSITIVE_INFINITY
        : task.maxRuns - task.runCount;
    for (const day of days) {
      // A long interval holds at most a few runs a day; a short one is counted, not listed.
      const runs = runsBetween(task, Math.max(day.start, now), day.end, Math.min(remaining, 2_000));
      remaining -= runs.length;
      if (runs.length > AGENDA_MAX_BLOCKS_PER_DAY) {
        day.entries.push({ task, at: runs[0]!, runs: runs.length, past: false });
      } else {
        for (const at of runs) day.entries.push({ task, at, runs: 1, past: false });
      }
    }
  }
  return days.map((day) => ({ start: day.start, entries: day.entries.sort(byTime) }));
}

/** List order: next run first, then upcoming without a time (webhooks), then paused. */
export function sortScheduledTasks(tasks: ReadonlyArray<ScheduledTask>): ScheduledTask[] {
  const rank = (task: ScheduledTask) =>
    !task.enabled ? 2 : parse(task.nextRunAt) === null ? 1 : 0;
  return [...tasks].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (parse(a.nextRunAt) ?? 0) - (parse(b.nextRunAt) ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

/** Kanban palette names, in a stable order for hashing; skips slate so blocks stay colorful. */
const AGENDA_COLORS = ["blue", "violet", "green", "amber", "pink", "teal", "orange", "red"];

/** A stable color per task (a `KANBAN_COLORS` name), the same on every client. */
export function scheduledTaskColor(taskId: string): string {
  let hash = 0;
  for (let index = 0; index < taskId.length; index += 1) {
    hash = (hash * 31 + taskId.charCodeAt(index)) | 0;
  }
  return AGENDA_COLORS[Math.abs(hash) % AGENDA_COLORS.length]!;
}

const PAST_LABEL: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "ran",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
};

const agendaTimeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A block's second line: its time, then how the run went or how many runs it folds. */
export function agendaEntryDetail(entry: AgendaEntry): string {
  const time = agendaTimeFormat.format(entry.at);
  if (entry.past) return `${time} · ${PAST_LABEL[entry.task.lastRunStatus]}`;
  return entry.runs > 1 ? `${time} · ${entry.runs} runs` : time;
}
