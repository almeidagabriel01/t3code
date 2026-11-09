/**
 * Who may start now. Pure: the queue file feeds it the document, a clock reading and the latest
 * machine sample, so every waiter (CLI or server) reaches the same answer under the file lock.
 */
import type { HeavyQueueEntry } from "@t3tools/contracts";

export interface Sample {
  readonly at: number;
  /** Cores' worth of CPU in use right now, from the host's short-window utilisation, not the load average. */
  readonly busyCores: number;
  readonly cpuCount: number;
  readonly availableMemoryBytes: number;
  readonly totalMemoryBytes: number;
  /** Since when every sample showed headroom without a break; null while under pressure. */
  readonly headroomSince: number | null;
}

export interface Run {
  readonly cpu: number;
  readonly memoryBytes: number;
  readonly durationMs: number;
}

/** Last few finished runs per command signature. */
/** The machine is calm enough that admitting something could be considered. */
export const hasHeadroom = (sample: Omit<Sample, "headroomSince">) =>
  sample.availableMemoryBytes >= MEMORY_FLOOR * sample.totalMemoryBytes &&
  sample.busyCores <= CPU_CEILING * sample.cpuCount;

export type History = Readonly<Record<string, ReadonlyArray<Run>>>;

export const DEFAULT_MAX_RUNNING = 3;
export const HISTORY_RUNS = 5;
/** A newly started job needs this long to show its real load before another is admitted. */
const SETTLE_MS = 15_000;
/** Without a reading this fresh, only the first job runs; waiters take over sampling when no server does. */
export const SAMPLE_FRESH_MS = 15_000;
/** Headroom has to hold this long before another job is admitted. */
const HEADROOM_MS = 6_000;
const MEMORY_FLOOR = 0.2;
/** Once blocked, memory has to recover a little past the floor so admission does not flap. */
const MEMORY_REOPEN = 0.25;
const CPU_CEILING = 0.7;
/** A head waiting this long stops anything from passing it. */
const HEAD_PATIENCE_MS = 5 * 60_000;
const GIB = 1024 ** 3;

type Kind = "exclusive" | "heavy" | "medium";

const EXCLUSIVE = /simulator|emulator|simctl|\bavd\b|expo run|dev:desktop|dev app/i;
const HEAVY = /\b(build|bundle|e2e|playwright|browser|docker|cargo|gradle|xcodebuild|compile)\b/i;
const MEDIUM = /\b(typecheck|tsc|lint|oxlint|fmt|format|check|check:changed)\b/i;
const FILE_ARG = /\S+\.(test|spec)\.\w+|\S+\.(ts|tsx|js|jsx|mjs)\b/;

/** Server-held entries are device opens; unknown commands count as heavy. */
export const kindOf = (entry: Pick<HeavyQueueEntry, "label" | "server">): Kind => {
  if (entry.server === true || EXCLUSIVE.test(entry.label)) return "exclusive";
  if (HEAVY.test(entry.label)) return "heavy";
  if (MEDIUM.test(entry.label) || (/\btest\b/.test(entry.label) && FILE_ARG.test(entry.label))) {
    return "medium";
  }
  return "heavy";
};

/** `vp test run src/a.test.ts --watch` and `vp test run src/b.test.ts` share `vp test run`. */
export const signatureOf = (label: string): string =>
  label
    .split(/\s+/)
    .filter((word) => word !== "" && !word.startsWith("-") && !/[\\/]|\.\w{1,5}$/.test(word))
    .slice(0, 4)
    .join(" ")
    .toLowerCase();

interface Cost {
  readonly cpu: number;
  readonly memoryBytes: number;
  /** Null until a run of this command finished with samples. */
  readonly durationMs: number | null;
}

export const estimate = (
  history: History,
  entry: Pick<HeavyQueueEntry, "label" | "server">,
  cpuCount: number,
): Cost => {
  const runs = history[signatureOf(entry.label)] ?? [];
  if (runs.length > 0) {
    const durations = runs.map((run) => run.durationMs).toSorted((a, b) => a - b);
    return {
      cpu: Math.max(...runs.map((run) => run.cpu)),
      memoryBytes: Math.max(...runs.map((run) => run.memoryBytes)),
      durationMs: durations[Math.floor(durations.length / 2)]!,
    };
  }
  const medium = kindOf(entry) === "medium";
  return {
    cpu: Math.min(medium ? 2 : 4, Math.max(1, cpuCount)),
    memoryBytes: (medium ? 1.5 : 4) * GIB,
    durationMs: null,
  };
};

export interface PlanInput {
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly maxRunning: number;
  readonly paused: boolean;
  readonly history: History;
  readonly sample: Sample | null;
  readonly lastStartAt: number | null;
  /** Admission was blocked last time, so memory must reach the higher reopen level. */
  readonly holding: boolean;
  readonly now: number;
}

export interface Plan {
  /** The one waiter that may start now. */
  readonly admit: string | null;
  /** Why each other waiter is not starting. */
  readonly reasons: Readonly<Record<string, string>>;
  /** False while pressure or the pause is what keeps waiters back. */
  readonly room: boolean;
  readonly holding: boolean;
}

const gb = (bytes: number) => `${(Math.max(0, bytes) / GIB).toFixed(1)} GB`;

export const plan = (input: PlanInput): Plan => {
  const { entries, now } = input;
  const running = entries.filter((entry) => entry.startedAt !== null);
  const waiting = entries.filter((entry) => entry.startedAt === null);
  const head = waiting[0];
  if (head === undefined) return { admit: null, reasons: {}, room: true, holding: false };

  const finish = (
    admit: string | null,
    headReason: string | null,
    room: boolean,
    holding: boolean,
  ) => {
    const reasons: Record<string, string> = {};
    for (const waiter of waiting) {
      if (waiter.id === admit) continue;
      reasons[waiter.id] =
        waiter.id === head.id ? (headReason ?? "next in line") : "waiting its turn";
    }
    return { admit, reasons, room, holding };
  };

  const forced = waiting.find((entry) => entry.forced === true);
  if (forced !== undefined) return finish(forced.id, null, true, input.holding);
  if (input.paused) return finish(null, "paused", false, input.holding);
  if (running.some((entry) => kindOf(entry) === "exclusive")) {
    return finish(null, "an exclusive job is running alone", false, input.holding);
  }
  if (running.length === 0) return finish(head.id, null, true, false);
  if (kindOf(head) === "exclusive") {
    return finish(null, "runs alone: waiting for the running ones to finish", false, input.holding);
  }
  if (running.length >= Math.max(1, input.maxRunning)) {
    return finish(null, `all ${input.maxRunning} slots are busy`, true, input.holding);
  }
  if (input.lastStartAt !== null && now - input.lastStartAt < SETTLE_MS) {
    return finish(null, "letting the last one ramp up", true, input.holding);
  }
  const { sample } = input;
  if (sample === null || now - sample.at > SAMPLE_FRESH_MS) {
    return finish(null, "waiting for a load reading", false, input.holding);
  }

  if (sample.headroomSince === null || now - sample.headroomSince < HEADROOM_MS) {
    return finish(null, "waiting for steady headroom", false, input.holding);
  }

  const floor = (input.holding ? MEMORY_REOPEN : MEMORY_FLOOR) * sample.totalMemoryBytes;
  const verdict = (entry: HeavyQueueEntry) => {
    const cost = estimate(input.history, entry, sample.cpuCount);
    const freeCores = sample.cpuCount * CPU_CEILING - sample.busyCores;
    if (sample.availableMemoryBytes - cost.memoryBytes < floor) {
      return {
        cost,
        fits: false,
        why: `waiting for room: needs ~${gb(cost.memoryBytes)}, ${gb(sample.availableMemoryBytes - floor)} free`,
      };
    }
    if (cost.cpu > freeCores) {
      return {
        cost,
        fits: false,
        why: `waiting for room: needs ~${cost.cpu.toFixed(1)} cores, ${Math.max(0, freeCores).toFixed(1)} free`,
      };
    }
    return { cost, fits: true, why: "" };
  };

  const headVerdict = verdict(head);
  if (headVerdict.fits) return finish(head.id, null, true, false);

  // Backfill: a later, smaller job may go only if it fits and ends before the head would fit.
  const waited = now - Date.parse(head.createdAt);
  const remaining = running.map((entry) => {
    const duration = estimate(input.history, entry, sample.cpuCount).durationMs;
    return duration === null ? null : Math.max(0, duration - (now - Date.parse(entry.startedAt!)));
  });
  const headWait = remaining.includes(null) ? null : Math.min(...(remaining as number[]));
  if (waited < HEAD_PATIENCE_MS && headWait !== null) {
    for (const waiter of waiting.slice(1)) {
      if (kindOf(waiter) === "exclusive") continue;
      const candidate = verdict(waiter);
      if (
        candidate.fits &&
        candidate.cost.durationMs !== null &&
        candidate.cost.durationMs <= headWait
      ) {
        return finish(waiter.id, headVerdict.why, false, true);
      }
    }
  }
  return finish(null, headVerdict.why, false, true);
};
