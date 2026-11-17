/**
 * Who may start now. Pure: the queue file feeds it the document, a clock reading and the latest
 * machine sample, so every waiter (CLI or server) reaches the same answer under the file lock.
 */
import { heavyHoldText, type HeavyQueueEntry, type HeavyQueueHold } from "@t3tools/contracts";

import { kindOf, runTarget } from "./commandShapes.ts";
import { filesOf, workPartsOf } from "./costClass.ts";
import { heavyRoute } from "./heavyHook.ts";

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
  /** A Gradle or Kotlin daemon is up: its memory is in this reading, not in a new job's cost. */
  readonly buildDaemonsAlive?: boolean;
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

/**
 * Folds one reading in; `previous` null after a gap in readings, which starts from "has room". An
 * older build's sample has only `headroomSince`: the run of readings under the limit goes on from it.
 */
export const sustain = (
  previous: (Partial<Sustained> & { readonly headroomSince?: number | null }) | null,
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
  const since = previous?.underLimitSince ?? previous?.headroomSince ?? at;
  return { overLimit: was && at - since < windowMs, overLimitSince: null, underLimitSince: since };
};

export interface Run {
  /** Absent when no sample read the job's processes. */
  readonly cpu?: number;
  readonly memoryBytes: number;
  /** Its own tree alone, when build daemons outside it were counted in `memoryBytes`. */
  readonly treeMemoryBytes?: number;
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
/**
 * After memory pressure or swapping held admission, memory has to recover this many points past the
 * floor so admission does not flap. A job too big to fit raises nothing: smaller ones still pass it.
 */
const MEMORY_REOPEN_POINTS = 5;
/** Sustained swap-in above this is the machine paging work back in, not a blip. */
export const SWAP_IN_LIMIT = 20 * 1024 ** 2;

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** How admission sizes jobs, kept in the queue file beside the Mac's limits. */
export interface SizingLimits {
  /** A command whose usual run stays under this may start while memory is short. */
  readonly lightJobMegabytes: number;
  /** What a command with no finished runs is taken to need. */
  readonly unseenHeavyMegabytes: number;
  readonly unseenMediumMegabytes: number;
  /** A head waiting this long stops anything from passing it. */
  readonly headPatienceMinutes: number;
}
type Guesses = Pick<SizingLimits, "unseenHeavyMegabytes" | "unseenMediumMegabytes">;

const TEST_RUN = /^(test|vitest|jest|playwright|pytest)$/;
const COMMAND_WORD = /^[a-z@][\w:.@+-]*$/i;

/** One work part's key: its program (past `exec`/`dlx`), subcommand words and file scope. */
const partSignature = (part: ReturnType<typeof workPartsOf>[number]) => {
  const { program, words } = runTarget(part.program, part.words);
  const command: string[] = [program];
  for (const word of words) {
    if (command.length > (program === "git" ? 1 : 3) || !COMMAND_WORD.test(word)) break;
    if (/\.\w{1,5}$/.test(word)) break;
    command.push(word);
  }
  const files = filesOf(part);
  const path = command.some((word) => TEST_RUN.test(word))
    ? files?.find((file) => file !== "")
    : undefined;
  // A test run keeps its target's last two segments, so one file never shares the suite's runs.
  const scope =
    path !== undefined
      ? path.split(/[\\/]/).filter(Boolean).slice(-2).join("/")
      : files === null
        ? null
        : "files";
  return [...command, ...(scope === null ? [] : [scope])].join(" ");
};

/**
 * A command's history key, from its parsed work: program, `exec` target, subcommand words and a
 * `files` scope. Redirections, variables, quoted arguments and commit messages never count, so
 * any worktree, `cd` or message shares one key.
 */
export const signatureOf = (line: string): string => {
  const parts = workPartsOf(line);
  const key =
    parts.length > 0
      ? parts.map(partSignature).join(" && ")
      : line.trim().split(/\s+/).slice(0, 4).join(" ");
  return key.toLowerCase();
};

/** A command's recorded runs, keyed by its whole line. Own keys only: `constructor` names none. */
export const runsOf = <A>(
  book: Readonly<Record<string, ReadonlyArray<A>>>,
  entry: Pick<HeavyQueueEntry, "label"> & { readonly line?: string },
): ReadonlyArray<A> => {
  const signature = signatureOf(entry.line ?? entry.label);
  return Object.hasOwn(book, signature) ? book[signature]! : [];
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
export const learnedCpu = (
  history: History,
  entry: Pick<HeavyQueueEntry, "label"> & { readonly line?: string },
) => {
  const cpus = runsOf(history, entry).flatMap((run) =>
    typeof run.cpu === "number" && run.cpu > 0 ? [run.cpu] : [],
  );
  return cpus.length === 0 ? undefined : Math.max(...cpus);
};

export const estimate = (
  history: History,
  entry: Pick<HeavyQueueEntry, "label" | "server"> & { readonly line?: string },
  cpuCount: number,
  guesses: Guesses,
  buildDaemonsAlive = false,
): Cost => {
  const runs = runsOf(history, entry);
  const medium = kindOf(entry) === "medium";
  const guessCpu = Math.min(medium ? 2 : 4, Math.max(1, cpuCount));
  // The usual run, not the worst: admission starts one job per settle window, so a run that
  // outgrows it shows in the next reading before anything else starts.
  const memoryBytes = median(
    runs.map((run) =>
      buildDaemonsAlive ? (run.treeMemoryBytes ?? run.memoryBytes) : run.memoryBytes,
    ),
  );
  if (memoryBytes !== null) {
    return {
      cpu: learnedCpu(history, entry) ?? guessCpu,
      memoryBytes,
      durationMs: medianDuration(runs),
    };
  }
  return {
    cpu: guessCpu,
    memoryBytes: (medium ? guesses.unseenMediumMegabytes : guesses.unseenHeavyMegabytes) * MIB,
    durationMs: null,
  };
};

/** Learned to stay small; a command never seen is not light. */
const isLight = (
  input: Pick<PlanInput, "history" | keyof SizingLimits>,
  entry: Pick<HeavyQueueEntry, "label" | "server"> & { readonly line?: string },
) =>
  runsOf(input.history, entry).length > 0 &&
  estimate(input.history, entry, 1, input).memoryBytes < input.lightJobMegabytes * MIB;

export interface PlanInput extends MacLimits, SizingLimits {
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly maxRunning: number;
  /** False: the queue is off and every waiter starts, so nothing below applies. */
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly history: History;
  readonly sample: Sample | null;
  /** Written for older builds, which wait one settle window after it; this one counts load instead. */
  readonly lastStartAt: number | null;
  /** Pressure or swapping held admission last time, so memory must reach the higher reopen level. */
  readonly holding: boolean;
  readonly now: number;
}

export interface Plan {
  /** Every waiter that may start now, in queue order. */
  readonly admits: ReadonlyArray<string>;
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

/** What this Mac can still take: memory above the floor and cores under the ceiling. */
export interface Budget {
  readonly memoryBytes: number;
  readonly cpu: number;
}

type BudgetInput = Pick<PlanInput, "history" | "holding" | "now" | keyof MacLimits | keyof Guesses>;

/**
 * Room left on `sample` once the jobs started in the last `SETTLE_MS` count their estimates: a
 * reading taken right after a start does not show its load yet.
 */
export const budgetOf = (
  input: BudgetInput,
  sample: Sample,
  running: ReadonlyArray<HeavyQueueEntry>,
): Budget => {
  const floorPercent = input.macMemoryFloorPercent + (input.holding ? MEMORY_REOPEN_POINTS : 0);
  const fresh = running.filter(
    (entry) => entry.startedAt !== null && input.now - Date.parse(entry.startedAt) < SETTLE_MS,
  );
  const committed = fresh.map((entry) =>
    estimate(input.history, entry, sample.cpuCount, input, sample.buildDaemonsAlive),
  );
  return {
    memoryBytes:
      sample.availableMemoryBytes -
      (floorPercent / 100) * sample.totalMemoryBytes -
      committed.reduce((sum, cost) => sum + cost.memoryBytes, 0),
    cpu:
      sample.cpuCount * (input.macCpuCeilingPercent / 100) -
      sample.busyCores -
      committed.reduce((sum, cost) => sum + cost.cpu, 0),
  };
};

const spend = (budget: Budget, cost: Pick<Cost, "cpu" | "memoryBytes">): Budget => ({
  memoryBytes: budget.memoryBytes - cost.memoryBytes,
  cpu: budget.cpu - cost.cpu,
});

/**
 * Whether `entry` fits in `budget` (this Mac's room after what started and was admitted), from
 * what its command used before: `plan`'s check, which Hybrid routing asks too.
 */
export const jobVerdict = (
  input: Pick<PlanInput, "history" | "macCpuCeilingPercent" | keyof Guesses>,
  sample: Sample,
  entry: Pick<HeavyQueueEntry, "label" | "server"> & { readonly line?: string },
  budget: Budget,
) => {
  const cost = estimate(input.history, entry, sample.cpuCount, input, sample.buildDaemonsAlive);
  if (cost.memoryBytes > budget.memoryBytes) {
    return {
      cost,
      hold: "job-memory" as const,
      why: `memory floor: ${gb(budget.memoryBytes)} room, needs ${gb(cost.memoryBytes)}`,
    };
  }
  if (cost.cpu > budget.cpu) {
    return {
      cost,
      hold: "job-cpu" as const,
      why: `needs ~${cost.cpu.toFixed(1)} cores; CPU ${pct(sample)}%, limit ${input.macCpuCeilingPercent}%`,
    };
  }
  return { cost, hold: null, why: "" };
};

const HELD_ROOM = new Set<HeavyQueueHold | null>([null, "slots", "committed"]);

/**
 * Pure: decides for one machine from its own sample and the entries it runs, so a second runner
 * plans by calling this with its own reading and its own entries. Every waiter that fits the room
 * left starts in the same pass, in queue order; a head that waited past its patience reserves its
 * room so the jobs behind it never starve it.
 */
export const plan = (input: PlanInput): Plan => {
  const { entries, now } = input;
  const running = entries.filter((entry) => entry.startedAt !== null);
  const waiting = entries.filter((entry) => entry.startedAt === null);
  if (waiting.length === 0 || heavyRoute(input) === "direct") {
    return {
      admits: waiting.map((entry) => entry.id),
      reasons: {},
      room: true,
      holding: false,
      hold: null,
    };
  }

  // The user released these: they start whatever holds the rest.
  const admits = waiting.filter((entry) => entry.forced === true).map((entry) => entry.id);
  const rest = waiting.filter((entry) => entry.forced !== true);
  const head = rest[0];
  const reasons: Record<string, string> = {};
  const holdText = (hold: HeavyQueueHold) =>
    hold === "job-memory" || hold === "job-cpu"
      ? "next in line"
      : heavyHoldText(hold, input.sample, input.maxRunning);
  const finish = (
    hold: HeavyQueueHold | null,
    holding: boolean,
    /** Waiters that were tried and did not fit, with their own reason. */
    tried: Readonly<Record<string, string>> = {},
  ): Plan => {
    const headHold = head === undefined || admits.includes(head.id) ? null : hold;
    for (const waiter of rest) {
      if (admits.includes(waiter.id)) continue;
      reasons[waiter.id] =
        tried[waiter.id] ??
        (waiter.id === head!.id && hold !== null ? holdText(hold) : "waiting its turn");
    }
    return { admits, reasons, room: HELD_ROOM.has(headHold), holding, hold: headHold };
  };
  if (head === undefined) return finish(null, input.holding);
  if (input.paused) return finish("paused", input.holding);
  if (running.some((entry) => kindOf(entry) === "exclusive")) {
    return finish("exclusive", input.holding);
  }
  // One job always runs: holding the only one back on pressure from elsewhere would starve agents.
  const first = running.length === 0 && admits.length === 0;
  if (first) {
    admits.push(head.id);
    if (kindOf(head) === "exclusive") return finish("exclusive", false);
  }
  const { sample } = input;
  if (sample === null || now - sample.at > SAMPLE_FRESH_MS) {
    return finish("no-reading", first ? false : input.holding);
  }
  const limit = machineHold(sample, input);
  const steady = sample.headroomSince !== null && now - sample.headroomSince >= HEADROOM_MS;
  const machine = limit ?? (steady ? null : ("steadying" as const));
  const holding = limit === "pressure" || limit === "swap-in" ? true : input.holding;
  // Short memory holds back only what would add to it; a busy CPU or critical pressure, everyone.
  const critical = (sample.pressureLevel ?? 0) >= 4;
  const passesMachine = (entry: HeavyQueueEntry) =>
    machine === null || (machine !== "cpu" && !critical && isLight(input, entry));

  const admitted = waiting.filter((entry) => admits.includes(entry.id));
  const plain = { ...input, holding };
  /** Room after the recent starts only, to tell "a job just started" from a full machine. */
  const settled = budgetOf({ ...plain, now: Infinity }, sample, running);
  let budget = admitted.reduce(
    (left, entry) =>
      spend(left, estimate(input.history, entry, sample.cpuCount, input, sample.buildDaemonsAlive)),
    budgetOf(plain, sample, running),
  );
  let slots = Math.max(1, input.maxRunning) - running.length - admitted.length;
  const aged = (entry: HeavyQueueEntry) =>
    now - Date.parse(entry.createdAt) >= input.headPatienceMinutes * 60_000;
  /** Room the aged head keeps for itself; the others start only in what is left. */
  let reserved = false;
  let draining = false;
  let headHold: HeavyQueueHold | null = null;
  const tried: Record<string, string> = {};
  const hold = (entry: HeavyQueueEntry, reason: HeavyQueueHold, why?: string) => {
    if (entry.id === head.id) headHold = reason;
    tried[entry.id] = why ?? holdText(reason);
  };

  for (const entry of rest) {
    if (admits.includes(entry.id)) continue;
    const isHead = entry.id === head.id;
    if (kindOf(entry) === "exclusive") {
      // It starts once nothing runs; aged at the head, nothing new joins what runs before it.
      if (isHead && aged(entry)) draining = true;
      if (isHead) hold(entry, "runs-alone");
      continue;
    }
    if (draining) {
      hold(entry, "draining");
      continue;
    }
    if (slots <= 0) {
      hold(entry, "slots");
      continue;
    }
    if (!passesMachine(entry)) {
      hold(entry, machine!, heavyHoldText(machine!, sample, input.maxRunning));
      continue;
    }
    const verdict = jobVerdict(input, sample, entry, budget);
    if (verdict.hold === null) {
      admits.push(entry.id);
      budget = spend(budget, verdict.cost);
      slots -= 1;
      continue;
    }
    const fitsSettled = jobVerdict(input, sample, entry, settled).hold === null;
    if (reserved) hold(entry, "reserved");
    else if (fitsSettled) hold(entry, "committed");
    else hold(entry, verdict.hold, verdict.why);
    // An aged head keeps its room only when the queue's own jobs ending would make it fit: a
    // shortage from load outside the queue blocks no one.
    if (isHead && aged(entry) && !fitsSettled) {
      const ours = running.reduce(
        (sum, job) =>
          sum +
          estimate(input.history, job, sample.cpuCount, input, sample.buildDaemonsAlive)
            .memoryBytes,
        0,
      );
      if (verdict.cost.memoryBytes <= budget.memoryBytes + ours) {
        budget = spend(budget, verdict.cost);
        reserved = true;
      }
    }
  }
  return finish(headHold, admits.includes(head.id) ? false : holding, tried);
};
