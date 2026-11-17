// @effect-diagnostics nodeBuiltinImport:off - Records are written by the plain-Node queue file.
/**
 * Heavy job notices. The queue file logs each transition where it is decided (a job ending, a
 * requeue, an admission, a deadline cancel), because the state alone loses why it happened. This
 * module turns those records, plus Linux health and long waits, into grouped toasts.
 */
import * as NodeCrypto from "node:crypto";
import type {
  HeavyNotice,
  HeavyNoticesMode,
  HeavyQueueEntry,
  HeavyQueueHold,
  HeavyRunner,
  HeavyRunnerPhase,
  RunnerFailedPolicy,
  RunnerWhere,
} from "@t3tools/contracts";

/** What the Runner does next with a job Linux lost. */
export type FollowUp = RunnerFailedPolicy;

export type HeavyEvent =
  /** Exited with a failure; `phase` is where a Linux job was. */
  | {
      readonly kind: "ended";
      readonly code: number;
      readonly phase?: HeavyRunnerPhase;
      /** What in its worktree kept Linux from installing it, and the fix. */
      readonly worktree?: string;
    }
  /** Its Linux question went unanswered and the deadline action is Cancel. */
  | { readonly kind: "deadline"; readonly dropped: boolean }
  /** Linux dropped it mid-run, or was unavailable when it started there. */
  | {
      readonly kind: "linux-lost";
      readonly dropped: boolean;
      readonly followUp: FollowUp;
      readonly unconfirmed: boolean;
    }
  /** A part of a Linux job turned out to need this Mac. */
  | { readonly kind: "needs-mac"; readonly reason: string }
  /** Started on this Mac although it was bound for Linux. */
  | {
      readonly kind: "displaced";
      readonly cause: "unavailable" | "dropped" | "deadline";
    }
  /** Hybrid placed it on Linux: planned, shown only for every machine change. */
  | { readonly kind: "hybrid" }
  /** Linux couldn't run it for a reason of T3's or the PC's own; the problem detector files it and tells. */
  | ({ readonly kind: "t3-fault" } & Fault);

/** Each reason has an approved card label in the problem detector; a new one needs its label approved first. */
export type FaultReason =
  | "linux-sync"
  | "linux-install"
  | "linux-lost"
  | "command-not-found"
  | "network"
  | "disk-full"
  | "out-of-memory"
  | "sign-in-expired";

export interface Fault {
  /** Stable cause key; the same fault gives the same key every time, e.g. "linux-sync:rsync-timeout". */
  readonly cause: string;
  readonly reason: FaultReason;
  /** The command line that failed. */
  readonly command: string;
  /** The Linux error text; its first line is what the card shows. */
  readonly error: string;
  /** Absolute Mac path the job ran in (worktree or project root); null if unknown. */
  readonly projectFolder: string | null;
}

/** How a Linux run failed by its environment, as the CLI saw it. */
export type FaultSeen =
  /** The pre-flight found the tool missing there. */
  | { readonly kind: "missing"; readonly tool: string }
  /** It ran and exited 126 or 127: something it calls is missing or not executable there. */
  | { readonly kind: "exit"; readonly code: number; readonly program: string }
  /** A package's install was unfinished in the copy twice in a row. */
  | { readonly kind: "install"; readonly package: string | null }
  /** `remoto` reached the PC and started syncing, but the command never ran. */
  | { readonly kind: "sync" }
  /** `remoto` never got as far as syncing. */
  | { readonly kind: "unreachable" }
  /** It started there and the connection ended without its exit code. */
  | { readonly kind: "lost" };

/** Causes the PC itself gives, whatever step it failed at. */
const PC_CAUSES: ReadonlyArray<readonly [RegExp, FaultReason, string]> = [
  [/No space left on device|ENOSPC|Disk quota exceeded/i, "disk-full", "no-space"],
  [/Cannot allocate memory|ENOMEM|heap out of memory|Out of memory/i, "out-of-memory", "no-memory"],
  [
    /Permission denied \(publickey|Authentication failed|Too many authentication failures/i,
    "sign-in-expired",
    "ssh-key",
  ],
];
/** The PC or the network is away: Linux is offline, which the heartbeat shows, or dropped; no fault. */
const PC_UNREACHABLE =
  /PC indisponível|Could not resolve hostname|Name or service not known|Temporary failure in name resolution|timed? ?out|Host is down|Connection refused|No route to host|Network is unreachable|Connection (?:reset|closed)|closed by remote host|Broken pipe/i;
/** ssh's or `remoto`'s own line saying the PC is unreachable; later output (rsync's) must not hide it. */
export const unreachableLine = (text: string) =>
  /^(?:ssh: (?:connect to host|Could not resolve hostname) .*|\[remoto\] PC indisponível.*)$/m.exec(
    text.replace(/\r/g, ""),
  )?.[0] ?? null;
const lockfile = (file: string, install: string) =>
  `${file} is out of date in this worktree: run \`${install}\` on this Mac, then \`git add ${file}\``;
/**
 * Install failures the worktree's own files cause: Linux is fine and any machine fails the same,
 * so the job ends with the fix instead of a problem card or a rerun.
 */
const WORKTREE_PROBLEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /ERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_CONFIG_MISMATCH)|pnpm install --no-frozen-lockfile/,
    "pnpm-lock.yaml is out of date in this worktree: run `vp i` (or `pnpm install`) on this Mac, then `git add pnpm-lock.yaml`",
  ],
  [
    /`npm ci` can only install packages when your package\.json and package-lock\.json/,
    lockfile("package-lock.json", "npm install"),
  ],
  [
    /yarn was run with `--frozen-lockfile`|YN0028|lockfile would have been modified by this install/,
    lockfile("yarn.lock", "yarn install"),
  ],
  [
    /lockfile had changes, but lockfile is frozen/,
    "The bun lockfile is out of date in this worktree: run `bun install` on this Mac, then `git add` it",
  ],
  [
    /ERR_PNPM_JSON_PARSE|EJSONPARSE|while parsing .* in \S*package\.json/,
    "A package.json in this worktree is not valid JSON (an unresolved merge conflict?): fix it on this Mac",
  ],
];

/** The fix for an install output line that is the worktree's failure, or null. */
export const worktreeProblemOf = (line: string) =>
  WORKTREE_PROBLEMS.find(([pattern]) => pattern.test(line))?.[1] ?? null;

/** `vp: command not found`, `sh: 1: vp: not found`, `bash: ./x: Permission denied`. */
const MISSING_TOOL = /([^\s:]+): (?:command not found|not found|Permission denied)\s*$/;

/**
 * A Linux environment failure as the problem detector files it, with a cause key that stays the same for the
 * same fault: no counts, times or paths in it. Null when the run failed in its own code.
 */
export const faultOf = (
  seen: FaultSeen,
  error: string | null,
  job: { readonly command: string; readonly projectFolder: string | null },
): Fault | null => {
  const line = error?.trim() || null;
  const fault = (reason: FaultReason, detail: string, fallback: string): Fault => ({
    cause: `${reason}:${detail}`,
    reason,
    command: job.command,
    error: line ?? fallback,
    projectFolder: job.projectFolder,
  });
  if (seen.kind === "missing") {
    return fault("command-not-found", seen.tool, `${seen.tool}: command not found`);
  }
  if (seen.kind === "exit") {
    if (seen.code !== 126 && seen.code !== 127) return null;
    const tool = (line === null ? null : MISSING_TOOL.exec(line)?.[1]) ?? seen.program;
    return fault("command-not-found", tool, `${tool}: command not found`);
  }
  if (line !== null && PC_UNREACHABLE.test(line)) return null;
  const pc = line === null ? undefined : PC_CAUSES.find(([pattern]) => pattern.test(line));
  if (pc !== undefined) return fault(pc[1], `${seen.kind}-${pc[2]}`, "");
  if (seen.kind === "install") {
    return fault(
      "linux-install",
      seen.package ?? "node_modules",
      "Dependency install on Linux failed",
    );
  }
  const via = line !== null && /rsync/i.test(line) ? "rsync-unknown" : "unknown";
  if (seen.kind === "sync") return fault("linux-sync", via, "Linux sync failed");
  if (seen.kind === "lost") return fault("linux-lost", via, "Linux dropped the job");
  return null;
};

/** The record of a fault, beside the job's own `ended` or `linux-lost` record. */
export const faultRecord = (
  entry: Pick<HeavyQueueEntry, "id" | "label" | "name" | "threadId" | "runner">,
  fault: Fault,
  now: number,
): HeavyEventRecord => recordOf(entry, { kind: "t3-fault", ...fault }, now);

export type HeavyEventRecord = HeavyEvent & {
  readonly id: string;
  readonly at: number;
  readonly job: {
    readonly id: string;
    readonly name: string;
    /** The command it ran; absent in records written before it was kept. */
    readonly label?: string;
    readonly threadId: string | null;
    readonly runner: HeavyRunner;
  };
};

export const EVENT_LOG_SIZE = 50;

/** Exit codes that mean someone stopped it: removed (125) or a signal. */
const STOPPED_CODES = new Set([0, 125, 129, 130, 143]);

const recordOf = (
  entry: Pick<HeavyQueueEntry, "id" | "label" | "name" | "threadId" | "runner">,
  event: HeavyEvent,
  now: number,
): HeavyEventRecord => ({
  ...event,
  id: NodeCrypto.randomUUID(),
  at: now,
  job: {
    id: entry.id,
    name: entry.name ?? entry.label,
    // `name` is already the command unless --name gave it another.
    ...(entry.name === undefined ? {} : { label: entry.label }),
    threadId: entry.threadId,
    runner: entry.runner ?? "mac",
  },
});

/** A job's own process ending; null for success, a stop, or an entry already gone. */
export const endedRecord = (
  entry: (HeavyQueueEntry & { readonly worktree?: string }) | undefined,
  code: number,
  now: number,
): HeavyEventRecord | null =>
  entry === undefined || STOPPED_CODES.has(code)
    ? null
    : recordOf(
        entry,
        {
          kind: "ended",
          code,
          ...(entry.runner === "linux" && entry.phase !== undefined ? { phase: entry.phase } : {}),
          ...(entry.runner === "linux" && entry.worktree !== undefined
            ? { worktree: entry.worktree }
            : {}),
        },
        now,
      );

export const deadlineRecord = (entry: HeavyQueueEntry, now: number) =>
  recordOf(entry, { kind: "deadline", dropped: entry.dropped === true }, now);

/**
 * A stopped attempt going back in line. A route without a reason is the user's move, which
 * needs no notice.
 */
export const requeueRecord = (
  entry: HeavyQueueEntry,
  next: {
    readonly route?: HeavyRunner;
    readonly routeReason?: string;
    readonly dropped?: boolean;
    readonly unconfirmed?: boolean;
    readonly linuxFailedAt?: number;
  },
  policies: { readonly runnerDropped: FollowUp; readonly runnerUnavailable: FollowUp },
  now: number,
): HeavyEventRecord | null => {
  if (next.route === "mac" && next.routeReason !== undefined) {
    return recordOf(entry, { kind: "needs-mac", reason: next.routeReason }, now);
  }
  if (next.dropped !== true && next.linuxFailedAt === undefined) return null;
  const dropped = next.dropped === true;
  return recordOf(
    entry,
    {
      kind: "linux-lost",
      dropped,
      followUp: dropped ? policies.runnerDropped : policies.runnerUnavailable,
      unconfirmed: next.unconfirmed === true,
    },
    now,
  );
};

/** An admission on a machine other than the one the job's own settings chose. */
export const startRecord = (
  entry: HeavyQueueEntry,
  intent: RunnerWhere,
  runner: HeavyRunner,
  now: number,
): HeavyEventRecord | null => {
  if (intent === "automatic" && runner === "linux") return recordOf(entry, { kind: "hybrid" }, now);
  if (intent !== "linux" || runner !== "mac") return null;
  const cause =
    entry.dropped === true
      ? "dropped"
      : entry.ask !== undefined && Date.parse(entry.ask.deadlineAt) <= now
        ? "deadline"
        : "unavailable";
  return recordOf(entry, { kind: "displaced", cause }, now);
};

/** Appends to a bounded log, oldest out. */
export const withRecord = (
  log: ReadonlyArray<HeavyEventRecord>,
  record: HeavyEventRecord | null,
): ReadonlyArray<HeavyEventRecord> =>
  record === null ? log : [...log, record].slice(-EVENT_LOG_SIZE);

/** Tolerant read of the file's log: anything malformed is skipped, never fatal. */
export const parseLog = (value: unknown): ReadonlyArray<HeavyEventRecord> =>
  Array.isArray(value)
    ? (value.filter(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.kind === "string" &&
          item.job !== null &&
          typeof item.job === "object" &&
          typeof item.job.id === "string",
      ) as HeavyEventRecord[])
    : [];

/** A waiter waiting far past its usual time while its machine stays over its limits. */
export interface StuckJob {
  readonly job: HeavyEventRecord["job"];
  readonly waitedMs: number;
  readonly usualMs: number | null;
  readonly why: string;
}

/** Holds that mean the machine (or the job's own need) is over its limits. */
const LIMIT_HOLDS = new Set<HeavyQueueHold>([
  "pressure",
  "swap-in",
  "memory-floor",
  "cpu",
  "job-memory",
  "job-cpu",
]);
const MINUTE = 60_000;
/** Without history a job is stuck after this long; with history, after three usual runs (at least the floor). */
export const STUCK_NO_HISTORY_MS = 30 * MINUTE;
export const STUCK_FLOOR_MS = 10 * MINUTE;

export const stuckJobs = (input: {
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly routes: Readonly<Record<string, HeavyRunner>>;
  readonly macHold: HeavyQueueHold | null;
  readonly macHoldText: string | null;
  /** Waiters Linux holds back only for its own limits (`RoutePlan.linuxOver`). */
  readonly linuxOver: Readonly<Record<string, string>>;
  readonly usualMs: (entry: HeavyQueueEntry, runner: HeavyRunner) => number | null;
  readonly now: number;
}): ReadonlyArray<StuckJob> =>
  input.entries.flatMap((entry) => {
    if (entry.startedAt !== null || entry.ask !== undefined) return [];
    const runner = input.routes[entry.id] ?? "mac";
    const why =
      runner === "mac"
        ? input.macHold !== null && LIMIT_HOLDS.has(input.macHold)
          ? input.macHoldText
          : null
        : (input.linuxOver[entry.id] ?? null);
    if (why === null) return [];
    const usualMs = input.usualMs(entry, runner);
    const waitedMs = input.now - Date.parse(entry.createdAt);
    const limit = usualMs === null ? STUCK_NO_HISTORY_MS : Math.max(3 * usualMs, STUCK_FLOOR_MS);
    if (!(waitedMs > limit)) return [];
    return [
      {
        job: {
          id: entry.id,
          name: entry.name ?? entry.label,
          threadId: entry.threadId,
          runner,
        },
        waitedMs,
        usualMs,
        why,
      },
    ];
  });

export interface LinuxView {
  readonly host: string;
  readonly online: boolean | null;
  readonly error?: string;
  /** The last good check; with the transition it names it the same on every server. */
  readonly okAt: number | null;
}

/** What one tick saw that is new. */
export interface NoticeTick {
  readonly records: ReadonlyArray<HeavyEventRecord>;
  readonly linuxBefore: LinuxView | null;
  readonly linuxAfter: LinuxView | null;
  /** Jobs newly stuck this tick. */
  readonly stuck: ReadonlyArray<StuckJob>;
  /** Set when the queue file just became unreadable or unwritable. */
  readonly queueFileError: string | null;
  /** Jobs whose Linux loss already said they would run on this Mac. */
  readonly toldMac: ReadonlySet<string>;
}

type Category = "problem" | "unexpected" | "planned";

/** One notice before grouping: jobs with the same `group` in a window share a toast. */
export interface RawNotice {
  readonly group: string;
  /** Names the toast a group starts, the same on every server reading this queue file. */
  readonly seed: string;
  readonly category: Category;
  readonly tone: HeavyNotice["tone"];
  readonly machine: HeavyRunner;
  readonly job: HeavyEventRecord["job"] | null;
  /** Title for one job, then for several. */
  readonly one: string;
  readonly many: (count: number) => string;
  readonly description: string;
  /** Description for several jobs, when the single-job wording does not read in plural. */
  readonly manyDescription?: string;
}

const machineName = (runner: HeavyRunner) => (runner === "linux" ? "Linux" : "this Mac");
const short = (name: string) => (name.length > 60 ? `${name.slice(0, 59)}…` : name);
const jobs = (count: number) => `${count} jobs`;
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / MINUTE))} min`;

/** Tell the agent hands the failure back: the agent, not the user, does what comes next. */
const FOLLOW_UP: Record<Exclude<FollowUp, "agent">, string> = {
  mac: "Running it on this Mac instead",
  wait: "Waiting for Linux to come back",
  ask: "Waiting for your answer in the Resource Manager",
};

const recordNotice = (record: HeavyEventRecord, toldMac: ReadonlySet<string>): RawNotice | null => {
  const { job } = record;
  const name = short(job.name);
  const on = machineName(job.runner);
  const notice = (fields: Omit<RawNotice, "seed" | "job">): RawNotice => ({
    ...fields,
    seed: record.id,
    job,
  });
  switch (record.kind) {
    case "ended": {
      if (record.worktree !== undefined) {
        return notice({
          group: `worktree:${record.worktree}`,
          category: "problem",
          tone: "warning",
          machine: "linux",
          one: `${name} needs a fix in its worktree to run on Linux`,
          many: (n) => `${jobs(n)} need a fix in their worktree to run on Linux`,
          description: record.worktree,
        });
      }
      if (record.code === 126 || record.code === 127) {
        return notice({
          group: `start-failed:${job.runner}`,
          category: "problem",
          tone: "error",
          machine: job.runner,
          one: `${name} could not start on ${on}`,
          many: (n) => `${jobs(n)} could not start on ${on}`,
          description: `Command not found or not executable (exit ${record.code})`,
        });
      }
      if (record.phase === "syncing" || record.phase === "installing") {
        const step = record.phase === "syncing" ? "Linux sync" : "Dependency install on Linux";
        return notice({
          group: `${record.phase}-failed`,
          category: "problem",
          tone: "error",
          machine: "linux",
          one: `${step} failed for ${name}`,
          many: (n) => `${step} failed for ${jobs(n)}`,
          description: `Exit code ${record.code}`,
        });
      }
      return notice({
        group: `failed:${job.runner}`,
        category: "problem",
        tone: "error",
        machine: job.runner,
        one: `${name} failed on ${on}`,
        many: (n) => `${jobs(n)} failed on ${on}`,
        description: `Exit code ${record.code}`,
      });
    }
    case "deadline":
      return notice({
        group: "deadline",
        category: "problem",
        tone: "error",
        machine: "linux",
        one: `${name} was cancelled`,
        many: (n) => `${jobs(n)} were cancelled`,
        description: `${record.dropped ? "Linux dropped it" : "Linux was unavailable"} and nobody answered in time`,
      });
    case "linux-lost": {
      const steps = (several: boolean) => [
        ...(record.unconfirmed
          ? [
              several
                ? "Confirming the runs stopped there first"
                : "Confirming the run stopped there first",
            ]
          : []),
        ...(record.followUp === "agent"
          ? []
          : [
              several && record.followUp === "mac"
                ? "Running them on this Mac instead"
                : FOLLOW_UP[record.followUp],
            ]),
      ];
      return notice({
        group: `linux-lost:${record.dropped}:${record.followUp}`,
        category: "problem",
        tone: "warning",
        machine: "linux",
        one: record.dropped ? `Linux dropped ${name} mid-run` : `Linux was unavailable for ${name}`,
        many: (n) =>
          record.dropped
            ? `Linux dropped ${jobs(n)} mid-run`
            : `Linux was unavailable for ${jobs(n)}`,
        description: steps(false).join(". "),
        manyDescription: steps(true).join(". "),
      });
    }
    case "needs-mac":
      return notice({
        group: `needs-mac:${record.reason}`,
        category: "unexpected",
        tone: "info",
        machine: "mac",
        one: `${name} moved to this Mac`,
        many: (n) => `${jobs(n)} moved to this Mac`,
        description: record.reason,
      });
    case "displaced": {
      // The Linux loss notice already said it would run here.
      if (record.cause !== "deadline" && toldMac.has(job.id)) return null;
      return notice({
        group: `displaced:${record.cause}`,
        category: "unexpected",
        tone: "info",
        machine: "mac",
        one: `${name} moved to this Mac`,
        many: (n) => `${jobs(n)} moved to this Mac`,
        description:
          record.cause === "dropped"
            ? "Linux dropped it mid-run"
            : record.cause === "deadline"
              ? "Linux was unavailable and nobody answered in time"
              : "Linux is unavailable",
      });
    }
    // The problem detector files these and tells the user; the toasts above already cover the job.
    case "t3-fault":
      return null;
    case "hybrid":
      return notice({
        group: "hybrid",
        category: "planned",
        tone: "info",
        machine: "linux",
        one: `${name} went to Linux`,
        many: (n) => `${jobs(n)} went to Linux`,
        description: "Each job goes to the machine with the shorter queue.",
      });
  }
};

/** Every new notice of one tick, before the mode filter and grouping. */
export const rawNotices = (tick: NoticeTick): ReadonlyArray<RawNotice> => {
  const notices: RawNotice[] = [];
  const { linuxBefore: before, linuxAfter: after } = tick;
  // The first reading is the baseline, and the Runner turning off is not Linux going away.
  if (before !== null && after !== null && before.online !== null && after.online !== null) {
    if (before.online && !after.online) {
      notices.push({
        group: "linux-offline",
        seed: `linux-offline:${after.okAt}`,
        category: "problem",
        tone: "warning",
        machine: "linux",
        job: null,
        one: "Linux went offline",
        many: () => "Linux went offline",
        description: after.error ?? `No answer from ${after.host}`,
      });
    } else if (!before.online && after.online) {
      notices.push({
        group: "linux-online",
        seed: `linux-online:${after.okAt}`,
        category: "problem",
        tone: "info",
        machine: "linux",
        job: null,
        one: "Linux is back online",
        many: () => "Linux is back online",
        description: `Jobs bound for Linux run on ${after.host} again`,
      });
    }
  }
  if (tick.queueFileError !== null) {
    notices.push({
      group: "queue-file",
      seed: `queue-file:${tick.queueFileError}`,
      category: "problem",
      tone: "error",
      machine: "mac",
      job: null,
      one: "The heavy queue file is not usable",
      many: () => "The heavy queue file is not usable",
      description: tick.queueFileError,
    });
  }
  for (const record of tick.records) {
    const notice = recordNotice(record, tick.toldMac);
    if (notice !== null) notices.push(notice);
  }
  for (const stuck of tick.stuck) {
    const on = machineName(stuck.job.runner);
    notices.push({
      group: `stuck:${stuck.job.runner}`,
      seed: `stuck:${stuck.job.id}`,
      category: "problem",
      tone: "warning",
      machine: stuck.job.runner,
      job: stuck.job,
      one: `${short(stuck.job.name)} has waited ${minutes(stuck.waitedMs)} on ${on}`,
      many: (n) => `${jobs(n)} are stuck waiting on ${on}`,
      description: `${on === "this Mac" ? "This Mac" : on} stays over its limits: ${stuck.why}${stuck.usualMs === null ? "" : `. It usually takes ${minutes(stuck.usualMs)}`}`,
    });
  }
  return notices;
};

const SHOWN: Record<HeavyNoticesMode, ReadonlySet<Category>> = {
  unexpected: new Set(["problem", "unexpected"]),
  "every-move": new Set(["problem", "unexpected", "planned"]),
  problems: new Set(["problem"]),
  off: new Set(),
};

export const shownIn = (mode: HeavyNoticesMode, notice: RawNotice) =>
  SHOWN[mode].has(notice.category);

/** Notices of one group share a toast for this long after its first one. */
const GROUP_WINDOW_MS = 60_000;

export interface OpenGroup {
  readonly id: string;
  readonly until: number;
  readonly jobs: ReadonlyArray<HeavyEventRecord["job"]>;
  readonly descriptions: ReadonlyArray<string>;
}

/**
 * Folds a tick's notices into toasts. A group still open re-sends its toast id with the new
 * count, so clients replace it instead of stacking another.
 */
export const groupNotices = (
  notices: ReadonlyArray<RawNotice>,
  open: ReadonlyMap<string, OpenGroup>,
  now: number,
): {
  readonly batch: ReadonlyArray<HeavyNotice>;
  readonly open: ReadonlyMap<string, OpenGroup>;
} => {
  const next = new Map([...open].filter(([, group]) => group.until > now));
  const touched = new Map<string, RawNotice>();
  for (const notice of notices) {
    const current = next.get(notice.group);
    const group: OpenGroup = current ?? {
      id: notice.seed,
      until: now + GROUP_WINDOW_MS,
      jobs: [],
      descriptions: [],
    };
    next.set(notice.group, {
      ...group,
      jobs:
        notice.job === null || group.jobs.some((job) => job.id === notice.job!.id)
          ? group.jobs
          : [...group.jobs, notice.job],
      descriptions: group.descriptions.includes(notice.description)
        ? group.descriptions
        : [...group.descriptions, notice.description],
    });
    touched.set(notice.group, notice);
  }
  const batch = [...touched].map(([key, notice]): HeavyNotice => {
    const group = next.get(key)!;
    const count = group.jobs.length;
    const several = count > 1;
    return {
      id: group.id,
      tone: notice.tone,
      title: several ? notice.many(count) : notice.one,
      description: several
        ? group.descriptions.length === 1
          ? (notice.manyDescription ?? group.descriptions[0]!)
          : group.jobs.map((job) => short(job.name)).join(", ")
        : notice.description,
      machine: notice.machine,
      threadId: several ? null : (group.jobs[0]?.threadId ?? null),
    };
  });
  return { batch, open: next };
};
