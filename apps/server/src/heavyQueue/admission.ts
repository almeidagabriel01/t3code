/**
 * Who may start now. Pure: the queue file feeds it the document, a clock reading and the latest
 * machine sample, so every waiter (CLI or server) reaches the same answer under the file lock.
 */
import { heavyHoldText, type HeavyQueueEntry, type HeavyQueueHold } from "@t3tools/contracts";

import { heavyRoute, heavySegment } from "./heavyHook.ts";

export interface Sample {
  readonly at: number;
  /** Cores' worth of CPU in use right now, from the host's short-window utilisation, not the load average. */
  readonly busyCores: number;
  readonly cpuCount: number;
  readonly availableMemoryBytes: number;
  readonly totalMemoryBytes: number;
  /** Since when every sample showed headroom without a break; null while under pressure. */
  readonly headroomSince: number | null;
  /** macOS memory pressure level (2 warning, 4 critical); absent from older readers. */
  readonly pressureLevel?: number | null;
  readonly swapInBytesPerSecond?: number | null;
  /** Routing's view of the limits; absent from older files, which read as room. */
  readonly overLimit?: boolean;
  readonly overLimitSince?: number | null;
  readonly underLimitSince?: number | null;
  /** Whether agents' running jobs should run slowed: CPU alone, counting slowed jobs at full speed. */
  readonly slow?: Sustained;
}

/** The Mac's limits, kept in the queue file so a waiter reads them without a server. */
export interface MacLimits {
  readonly macMemoryFloorPercent: number;
  readonly macCpuCeilingPercent: number;
}

/**
 * Whether a machine counts as over its limits for routing. It flips only after readings stay on
 * the other side for the whole window, so a spike at the moment of a check moves nothing.
 */
export interface Sustained {
  readonly overLimit: boolean;
  /** Start of the unbroken run of readings over the limit; null while the latest is under. */
  readonly overLimitSince: number | null;
  readonly underLimitSince: number | null;
}

/** Folds one reading in; `previous` null after a gap in readings, which starts from "has room". */
export const sustain = (
  previous: Partial<Sustained> | null,
  over: boolean,
  at: number,
  windowMs: number,
): Sustained => {
  const was = previous?.overLimit === true;
  if (over) {
    const since = previous?.overLimitSince ?? at;
    return {
      overLimit: was || at - since >= windowMs,
      overLimitSince: since,
      underLimitSince: null,
    };
  }
  const since = previous?.underLimitSince ?? at;
  return { overLimit: was && at - since < windowMs, overLimitSince: null, underLimitSince: since };
};

export interface Run {
  /** Absent when no sample read the job's processes. */
  readonly cpu?: number;
  readonly memoryBytes: number;
  readonly durationMs: number;
}

type Reading = Omit<Sample, "headroomSince">;

/** The machine-wide limit a reading is past, kernel signals first, or null when it has headroom. */
export const machineHold = (sample: Reading, limits: MacLimits) => {
  if ((sample.pressureLevel ?? 0) >= 2) return "pressure";
  if ((sample.swapInBytesPerSecond ?? 0) > SWAP_IN_LIMIT) return "swap-in";
  if (
    sample.availableMemoryBytes <
    (limits.macMemoryFloorPercent / 100) * sample.totalMemoryBytes
  ) {
    return "memory-floor";
  }
  if (sample.busyCores > (limits.macCpuCeilingPercent / 100) * sample.cpuCount) return "cpu";
  return null;
};

/** The machine is calm enough that admitting something could be considered. */
export const hasHeadroom = (sample: Reading, limits: MacLimits) =>
  machineHold(sample, limits) === null;

/** Workers a starting job's runners get: the cores free now, all but one on an idle machine. */
export const workersFor = (cpuCount: number, busyCores: number | null): number =>
  Math.max(2, Math.min(cpuCount - 1, Math.floor(cpuCount - (busyCores ?? 0))));

export type History = Readonly<Record<string, ReadonlyArray<Run>>>;
/** Linux runs by command: only their time, since their usage is measured on the PC, not here. */
export type LinuxHistory = Readonly<Record<string, ReadonlyArray<{ readonly durationMs: number }>>>;

const median = (values: ReadonlyArray<number>) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? null;

/** The middle run's time, or null without runs. */
export const medianDuration = (runs: ReadonlyArray<{ readonly durationMs: number }>) =>
  median(runs.map((run) => run.durationMs));

export const DEFAULT_MAX_RUNNING = 3;
export const HISTORY_RUNS = 5;
/** A newly started job needs this long to show its real load before another is admitted. */
const SETTLE_MS = 15_000;
/** Without a reading this fresh, only the first job runs; waiters take over sampling when no server does. */
export const SAMPLE_FRESH_MS = 15_000;
/** Headroom has to hold this long before another job is admitted. */
const HEADROOM_MS = 6_000;
/** Once blocked, memory has to recover this many points past the floor so admission does not flap. */
const MEMORY_REOPEN_POINTS = 5;
/** Sustained swap-in above this is the machine paging work back in, not a blip. */
export const SWAP_IN_LIMIT = 20 * 1024 ** 2;

/** A head waiting this long stops anything from passing it. */
const HEAD_PATIENCE_MS = 5 * 60_000;
const GIB = 1024 ** 3;
/** A command whose usual run stays under this may start while memory is short: it barely adds to it. */
const LIGHT_BYTES = 512 * 1024 ** 2;

type Kind = "exclusive" | "heavy" | "medium";

const EXCLUSIVE = /simulator|emulator|simctl|\bavd\b|expo run|dev:desktop|dev app/i;
const HEAVY = /\b(build|bundle|e2e|playwright|browser|docker|cargo|gradle|xcodebuild|compile)\b/i;
const MEDIUM = /\b(typecheck|tsc|lint|oxlint|fmt|format|check|check:changed)\b/i;
const FILE_ARG = /\S+\.(test|spec)\.\w+|\S+\.(ts|tsx|js|jsx|mjs)\b/;

/** Server-held entries are device opens; unknown commands count as heavy. */
/** Judged from the full command line: the label is cut short for the row. */
export const kindOf = (
  entry: Pick<HeavyQueueEntry, "label" | "server"> & { readonly line?: string },
): Kind => {
  const line = entry.line ?? entry.label;
  if (entry.server === true || EXCLUSIVE.test(line)) return "exclusive";
  if (HEAVY.test(line)) return "heavy";
  if (MEDIUM.test(line) || (/\btest\b/.test(line) && FILE_ARG.test(line))) {
    return "medium";
  }
  return "heavy";
};

/**
 * The command's first words plus the first path it names, so `vp test run src/a.test.ts --watch`
 * and `cd x && vp test run src/a.test.ts` share one, while a single file never shares the suite's.
 */
export const signatureOf = (label: string): string => {
  const words = (heavySegment(label) ?? label)
    .split(/\s+/)
    .filter((word) => word !== "" && !word.startsWith("-"));
  const isPath = (word: string) => /[\\/]|\.\w{1,5}$/.test(word);
  const path = words.find(isPath);
  return [
    ...words.filter((word) => !isPath(word)).slice(0, 4),
    ...(path === undefined ? [] : [path]),
  ]
    .join(" ")
    .toLowerCase();
};

interface Cost {
  readonly cpu: number;
  readonly memoryBytes: number;
  /** Null until a run of this command finished with samples. */
  readonly durationMs: number | null;
}

/**
 * The most CPU a command's finished runs used; undefined when none was read. Older files hold 0
 * for runs whose processes the monitor never saw, so only a positive reading counts.
 */
export const learnedCpu = (history: History, entry: Pick<HeavyQueueEntry, "label">) => {
  const cpus = (history[signatureOf(entry.label)] ?? []).flatMap((run) =>
    typeof run.cpu === "number" && run.cpu > 0 ? [run.cpu] : [],
  );
  return cpus.length === 0 ? undefined : Math.max(...cpus);
};

export const estimate = (
  history: History,
  entry: Pick<HeavyQueueEntry, "label" | "server">,
  cpuCount: number,
): Cost => {
  const runs = history[signatureOf(entry.label)] ?? [];
  const medium = kindOf(entry) === "medium";
  const guessCpu = Math.min(medium ? 2 : 4, Math.max(1, cpuCount));
  // The usual run, not the worst: admission starts one job per settle window, so a run that
  // outgrows it shows in the next reading before anything else starts.
  const memoryBytes = median(runs.map((run) => run.memoryBytes));
  if (memoryBytes !== null) {
    return {
      cpu: learnedCpu(history, entry) ?? guessCpu,
      memoryBytes,
      durationMs: medianDuration(runs),
    };
  }
  return {
    cpu: guessCpu,
    memoryBytes: (medium ? 0.5 : 1.5) * GIB,
    durationMs: null,
  };
};

/** Learned to stay small; a command never seen is not light. */
const isLight = (history: History, entry: Pick<HeavyQueueEntry, "label" | "server">) =>
  (history[signatureOf(entry.label)] ?? []).length > 0 &&
  estimate(history, entry, 1).memoryBytes < LIGHT_BYTES;

export interface PlanInput extends MacLimits {
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly maxRunning: number;
  /** False: the queue is off and every waiter starts, so nothing below applies. */
  readonly enabled: boolean;
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
  /** What holds the head back; null when it starts or nothing waits. */
  readonly hold: HeavyQueueHold | null;
}

const gb = (bytes: number) => `${(Math.max(0, bytes) / GIB).toFixed(1)} GB`;
/** Rounded as the summary shows it, so a row and the summary never disagree. */
const pct = (sample: Sample) => Math.round((sample.busyCores / Math.max(1, sample.cpuCount)) * 100);

/**
 * Whether `entry` fits on this Mac on top of what runs now, from what its command used before:
 * `plan`'s check for the head, which Hybrid routing asks too.
 */
export const jobVerdict = (
  input: Pick<PlanInput, "history" | "holding" | keyof MacLimits>,
  sample: Sample,
  entry: Pick<HeavyQueueEntry, "label" | "server">,
) => {
  const floorPercent = input.macMemoryFloorPercent + (input.holding ? MEMORY_REOPEN_POINTS : 0);
  const floor = (floorPercent / 100) * sample.totalMemoryBytes;
  const cost = estimate(input.history, entry, sample.cpuCount);
  if (sample.availableMemoryBytes - cost.memoryBytes < floor) {
    return {
      cost,
      hold: "job-memory" as const,
      why: `needs ~${gb(cost.memoryBytes)}; ${gb(sample.availableMemoryBytes)} free, ${gb(floor)} kept spare`,
    };
  }
  if (cost.cpu > sample.cpuCount * (input.macCpuCeilingPercent / 100) - sample.busyCores) {
    return {
      cost,
      hold: "job-cpu" as const,
      why: `needs ~${cost.cpu.toFixed(1)} cores; CPU ${pct(sample)}%, limit ${input.macCpuCeilingPercent}%`,
    };
  }
  return { cost, hold: null, why: "" };
};

/**
 * Pure: decides for one machine from its own sample and the entries it runs, so a second runner
 * plans by calling this with its own reading and its own entries.
 */
export const plan = (input: PlanInput): Plan => {
  const { entries, now } = input;
  const running = entries.filter((entry) => entry.startedAt !== null);
  const waiting = entries.filter((entry) => entry.startedAt === null);
  const head = waiting[0];
  if (head === undefined || heavyRoute(input) === "direct") {
    return { admit: head?.id ?? null, reasons: {}, room: true, holding: false, hold: null };
  }

  const finish = (
    admit: string | null,
    hold: HeavyQueueHold | null,
    room: boolean,
    holding: boolean,
    headReason?: string,
    /** Waiters behind the head that were tried and did not fit, with their own reason. */
    tried: Readonly<Record<string, string>> = {},
  ): Plan => {
    const why =
      headReason ??
      (hold === null || hold === "job-memory" || hold === "job-cpu"
        ? "next in line"
        : heavyHoldText(hold, input.sample, input.maxRunning));
    const reasons: Record<string, string> = {};
    for (const waiter of waiting) {
      if (waiter.id === admit) continue;
      reasons[waiter.id] = waiter.id === head.id ? why : (tried[waiter.id] ?? "waiting its turn");
    }
    return { admit, reasons, room, holding, hold: admit === head.id ? null : hold };
  };

  const forced = waiting.find((entry) => entry.forced === true);
  if (forced !== undefined) return finish(forced.id, null, true, input.holding);
  if (input.paused) return finish(null, "paused", false, input.holding);
  if (running.some((entry) => kindOf(entry) === "exclusive")) {
    return finish(null, "exclusive", false, input.holding);
  }
  // One job always runs: holding the only one back on pressure from elsewhere would starve agents.
  if (running.length === 0) return finish(head.id, null, true, false);
  if (kindOf(head) === "exclusive") return finish(null, "runs-alone", false, input.holding);
  if (running.length >= Math.max(1, input.maxRunning)) {
    return finish(null, "slots", true, input.holding);
  }
  if (input.lastStartAt !== null && now - input.lastStartAt < SETTLE_MS) {
    return finish(null, "settling", true, input.holding);
  }
  const { sample } = input;
  if (sample === null || now - sample.at > SAMPLE_FRESH_MS) {
    return finish(null, "no-reading", false, input.holding);
  }
  const limit = machineHold(sample, input);
  const steady = sample.headroomSince !== null && now - sample.headroomSince >= HEADROOM_MS;
  const machine = limit ?? (steady ? null : ("steadying" as const));
  const holding = limit === "pressure" || limit === "swap-in" ? true : input.holding;

  // Short memory holds back only what would add to it; a busy CPU holds back everyone.
  const verdict = (entry: HeavyQueueEntry): { hold: HeavyQueueHold | null; why: string } => {
    const job = jobVerdict(input, sample, entry);
    if (machine === null) return job;
    if (machine !== "cpu" && isLight(input.history, entry) && job.hold !== "job-cpu") {
      return { hold: null, why: "" };
    }
    return { hold: machine, why: heavyHoldText(machine, sample, input.maxRunning) };
  };
  const headVerdict = verdict(head);
  if (headVerdict.hold === null) return finish(head.id, null, true, false);
  const held = headVerdict.hold === "job-memory" || headVerdict.hold === "job-cpu" || holding;

  // A later job that fits passes a head that does not, until the head has waited its patience.
  const tried: Record<string, string> = {};
  if (now - Date.parse(head.createdAt) < HEAD_PATIENCE_MS) {
    for (const waiter of waiting.slice(1)) {
      if (kindOf(waiter) === "exclusive") continue;
      const fit = verdict(waiter);
      if (fit.hold === null) {
        return finish(waiter.id, headVerdict.hold, false, held, headVerdict.why, tried);
      }
      tried[waiter.id] = fit.why;
    }
  }
  return finish(null, headVerdict.hold, false, held, headVerdict.why, tried);
};
