/**
 * Runner wording and decisions both clients show: the line that says what the queue and the
 * Runner do together, the Linux status, a row's runner and phase, and its move actions.
 */
import type {
  HeavyQueueEntry,
  HeavyQueueLimitKey,
  HeavyQueueState,
  HeavyRunner,
  HeavyRunnerLinux,
  HeavyRunnerLinuxOver,
  HeavyRunnerPhase,
  RunnerDeadlineAction,
  RunnerFailedPolicy,
  RunnerLinuxFullPolicy,
  RunnerUnavailablePolicy,
  RunnerWhere,
} from "@t3tools/contracts";
import {
  HEAVY_QUEUE_DEFAULTS,
  RUNNER_DEFAULTS,
  formatBytes,
  linuxOverText,
} from "@t3tools/contracts";

export type RunnerSettingKey = keyof typeof RUNNER_DEFAULTS;

/** Every Runner setting's label and description; web and mobile both read these. */
export const RUNNER_SETTING_COPY: Record<
  RunnerSettingKey,
  { readonly title: string; readonly description: string }
> = {
  runnerEnabled: {
    title: "Use the Runner",
    description:
      "Runs heavy jobs on a Linux PC over SSH as well as on this Mac. Works with the queue on or off.",
  },
  runnerWhere: {
    title: "Where heavy work runs",
    description:
      "This Mac keeps everything here. Mac first fills this Mac, then sends the rest to Linux. Hybrid splits jobs between both. Linux sends every job it can run there.",
  },
  runnerMacOnly: {
    title: "Always on this Mac",
    description:
      "A heavy command that matches one of these always runs on this Mac; one asked to run on Linux ends with why instead.",
  },
  runnerUnavailable: {
    title: "When Linux is offline",
    description: "What a job headed for Linux does while Linux is offline.",
  },
  runnerLinuxFull: {
    title: "When Linux is full",
    description:
      "What a job headed for Linux does while every Linux slot is taken or Linux is past its limits.",
  },
  runnerDropped: {
    title: "If a Linux run fails",
    description:
      "What a job does when the PC drops its run and its retries run out. A command Linux lacks a tool or folder for runs again on this Mac by itself.",
  },
  runnerAskMinutes: {
    title: "Wait for an answer",
    description:
      "How long Ask me waits for your answer. An agent's foreground command gives up after 10 minutes, so a longer wait only helps background commands.",
  },
  runnerDeadlineAction: {
    title: "If nobody answers",
    description: "What happens when nobody answers in time.",
  },
  runnerMacFirstAfter: {
    title: "Send to Linux after",
    description:
      "Mac first sends a job to Linux once this Mac has this many jobs running or waiting.",
  },
  runnerBringBack: {
    title: "Bring results back",
    description:
      "Copies the files a Linux job created or changed back to this Mac. A file changed here during the job is left alone, and a file deleted there stays here.",
  },
  runnerBringBackExclude: {
    title: "Never bring back",
    description: "File or folder names, `*` allowed, that a Linux job never copies back.",
  },
  runnerBringBackMaxMB: {
    title: "Bring back up to",
    description:
      "A Linux run whose results come to more than this many MB copies nothing back, and its card says so.",
  },
  runnerMacTools: {
    title: "Mac-only tools",
    description:
      "Programs only this Mac has. A heavy command that runs one stays here; one asked to run on Linux ends with why instead.",
  },
  runnerRouteMemoryDays: {
    title: "Remember Linux failures for",
    description:
      "A command Linux failed to run for a tool or file it lacks runs on this Mac for this many days. `t3 heavy routes --forget` clears one sooner.",
  },
  runnerRouteLearnAfter: {
    title: "Learn a Linux failure after",
    description:
      "How many times Linux must fail a command for a tool or file it lacks before that command runs on this Mac instead.",
  },
  runnerHost: {
    title: "Linux host",
    description: "The Linux PC, as an alias from ~/.ssh/config or user@host.",
  },
  runnerLinuxSlots: {
    title: "Jobs at once on Linux",
    description: "How many heavy jobs Linux runs at the same time.",
  },
  runnerHeartbeatSeconds: {
    title: "Check Linux every",
    description: "How often this Mac checks that Linux is reachable and how busy it is.",
  },
  runnerOfflineAfterFailures: {
    title: "Mark Linux offline after",
    description: "Failed checks in a row before Linux counts as offline.",
  },
  runnerSshTimeoutSeconds: {
    title: "SSH timeout",
    description: "How long one SSH check waits before it counts as failed.",
  },
  runnerStopWaitSeconds: {
    title: "Wait for a stopped job",
    description: "How long a stopped Linux job gets to exit before it is killed.",
  },
  runnerLinuxMemoryFloorPercent: {
    title: "Keep memory free",
    description: "A new job waits while less than this share of the PC's memory is free.",
  },
  runnerLinuxCpuCeilingPercent: {
    title: "CPU limit",
    description: "A new job waits while the PC's CPU is busier than this.",
  },
  runnerLinuxEvictionsBeforeAlone: {
    title: "Run alone on Linux after",
    description:
      "A job Linux stopped this many times for lack of memory waits to run there with no other job.",
  },
};

/** In the order the choice shows them: from all-local to all-remote. */
export const RUNNER_WHERE_LABEL: Record<RunnerWhere, string> = {
  mac: "This Mac",
  macFirst: "Mac first",
  automatic: "Hybrid",
  linux: "Linux",
};

export const RUNNER_POLICY_LABEL: Record<RunnerUnavailablePolicy, string> = {
  ask: "Ask me",
  mac: "Run on this Mac",
  wait: "Wait for Linux",
};

/** In the order the choice shows them. */
export const RUNNER_LINUX_FULL_LABEL: Record<RunnerLinuxFullPolicy, string> = {
  wait: "Wait for Linux",
  mac: "Use this Mac",
  balance: "Balance by load",
};

export const RUNNER_LINUX_FULL_DESCRIPTION: Record<RunnerLinuxFullPolicy, string> = {
  wait: "Jobs wait for a free Linux slot.",
  mac: "When Linux is full and this Mac has room, the job runs here.",
  balance:
    "When Linux is full and this Mac's wait is shorter, the job waits here even with no room now. It does not go back.",
};

export const RUNNER_FAILED_POLICY_LABEL: Record<RunnerFailedPolicy, string> = {
  agent: "Tell the agent",
  ...RUNNER_POLICY_LABEL,
};

export const RUNNER_DEADLINE_LABEL: Record<RunnerDeadlineAction, string> = {
  mac: "Run on this Mac",
  wait: "Wait for Linux",
  cancel: "Cancel",
};

/** What a Linux job is doing, short enough for a row: "Installing · 3m". */
export const RUNNER_PHASE_LABEL: Record<HeavyRunnerPhase, string> = {
  syncing: "Syncing",
  installing: "Installing",
  running: "Running",
};

function memoryFloorDescription(lightJobMegabytes: number): string {
  return `A new heavy job waits while less than this much of this Mac's memory is free, unless it usually uses under ${lightJobMegabytes} MB.`;
}

/** The heavy queue's limit rows; web and mobile both read these. */
export const HEAVY_LIMIT_COPY: Record<
  HeavyQueueLimitKey,
  { readonly title: string; readonly description: string }
> = {
  macCpuCeilingPercent: {
    title: "CPU limit",
    description: "A new heavy job waits while this Mac's CPU stays above this.",
  },
  macMemoryFloorPercent: {
    title: "Keep memory free",
    description: memoryFloorDescription(HEAVY_QUEUE_DEFAULTS.lightJobMegabytes),
  },
  heavyOverLimitSeconds: {
    title: "Over the limit for",
    description:
      "How long this Mac or Linux must stay past a limit, or back under it, before jobs wait or move. A short spike changes nothing.",
  },
  lightJobMegabytes: {
    title: "Light job size",
    description:
      "A job whose runs on this Mac usually stayed under this may start even while memory is short. A command never run here is never light.",
  },
  unseenHeavyMegabytes: {
    title: "Memory guess for a new heavy job",
    description:
      "What a build, an end-to-end run or a whole test suite is expected to use before it has run on this Mac.",
  },
  unseenMediumMegabytes: {
    title: "Memory guess for a new medium job",
    description:
      "What a lint, a typecheck or a single test file is expected to use before it has run on this Mac.",
  },
  historyCommands: {
    title: "Commands remembered",
    description:
      "How many different commands keep their past runs for these estimates. Past that, the one run longest ago is forgotten.",
  },
  headPatienceMinutes: {
    title: "Let smaller jobs pass for",
    description:
      "While the first job in line does not fit, smaller ones behind it may start. Once it has waited this long, nothing passes it.",
  },
  quickSeconds: {
    title: "Quick job length",
    description:
      "A command that usually ends this fast, or names only a few files, starts in its own slots instead of waiting behind long jobs.",
  },
  quickSlots: {
    title: "Quick jobs at once",
    description: "How many quick jobs may run beside the regular job slots.",
  },
  serviceIdleMinutes: {
    title: "Idle job counts as running in the background after",
    description:
      "A job that has run this long and then sits idle stops holding a slot: its load still counts in this Mac's reading.",
  },
  reclaimMinutes: {
    title: "Keep a stopped agent's place for",
    description:
      "When an agent's command stops while waiting, its place in line is kept this long for the agent to ask again.",
  },
};

/** A limit's description as drawn; the memory floor's exception follows the light job size. */
export const heavyLimitDescription = (key: HeavyQueueLimitKey, lightJobMegabytes: number) =>
  key === "macMemoryFloorPercent"
    ? memoryFloorDescription(lightJobMegabytes)
    : HEAVY_LIMIT_COPY[key].description;

export const HEAVY_NOTICES_COPY = {
  title: "Heavy job notices",
  description:
    "Toasts when a heavy job fails, gets stuck or runs on another machine than planned, on this Mac or Linux.",
} as const;

/** A machine as a sentence names it: "this Mac", "Linux". */
export const RUNNER_NAME: Record<HeavyRunner, string> = { mac: "this Mac", linux: "Linux" };

export interface HeavyModeInput {
  readonly queueEnabled: boolean;
  readonly queuePaused: boolean;
  readonly runnerEnabled: boolean;
  readonly where: RunnerWhere;
}

/** One sentence for the current queue × Runner combination; both settings sections show it. */
export function heavyModeLine(mode: HeavyModeInput): string {
  const { queueEnabled, queuePaused, runnerEnabled, where } = mode;
  if (!runnerEnabled) {
    if (!queueEnabled) return "Heavy jobs start right away, with nothing tracking them.";
    return queuePaused
      ? "Queue paused: nothing new starts on this Mac."
      : "Heavy jobs wait their turn on this Mac.";
  }
  if (queueEnabled && queuePaused) return "Queue paused: nothing new starts on this Mac or Linux.";
  if (queueEnabled) {
    switch (where) {
      case "mac":
        return "Heavy jobs wait their turn on this Mac; nothing goes to Linux.";
      case "linux":
        return "Heavy jobs Linux can run go there; what needs this Mac waits its turn here.";
      case "automatic":
        return RUNNER_WHERE_DESCRIPTION.automatic;
      case "macFirst":
        return RUNNER_WHERE_DESCRIPTION.macFirst;
    }
  }
  switch (where) {
    case "mac":
      return "No queue: heavy jobs start on this Mac right away.";
    case "linux":
      return "No queue: jobs Linux can run wait for a Linux slot; what needs this Mac starts right away.";
    case "automatic":
      return RUNNER_WHERE_DESCRIPTION.automatic;
    case "macFirst":
      return RUNNER_WHERE_DESCRIPTION.macFirst;
  }
}

/**
 * Why Linux is over its limits, for words shown beside its CPU and memory readings: those two
 * limits name only their threshold, since the reading beside them carries the number.
 */
export function linuxOverReasons(linux: HeavyRunnerLinux): string | undefined {
  if (linux.status !== "over-limit") return undefined;
  const shown = (over: HeavyRunnerLinuxOver) =>
    over.limit === "memory"
      ? linux.availableMemoryBytes !== null
      : over.limit === "cpu" && linux.cpuPercent !== undefined && linux.cpuPercent !== null;
  const words = linux.overLimits?.map((over) => linuxOverText(over, shown(over))).join("; ");
  return words || linux.overLimitBy;
}

/** "Linux online · 1 of 2 running · CPU 12% · load 1.2 on 6 cores · 8.1 GB free", or why it is not. */
export function linuxLine(linux: HeavyRunnerLinux): string {
  const jobs = `${linux.running} of ${linux.slots} running`;
  if (linux.online === null) return `Checking Linux (${linux.host})…`;
  if (linux.status === "unresponsive") {
    return `Linux not responding, too loaded to answer${linux.error === undefined ? "" : `: ${linux.error}`}`;
  }
  if (!linux.online) {
    return `Linux offline${linux.error === undefined ? "" : `: ${linux.error}`}`;
  }
  const cpu =
    linux.cpuPercent === undefined || linux.cpuPercent === null
      ? ""
      : ` · CPU ${Math.round(linux.cpuPercent)}%`;
  const load =
    linux.load1 === null
      ? ""
      : ` · load ${linux.load1.toFixed(1)}${linux.cpuCount === null ? "" : ` on ${linux.cpuCount} cores`}`;
  const memory =
    linux.availableMemoryBytes === null ? "" : ` · ${formatBytes(linux.availableMemoryBytes)} free`;
  const reasons = linuxOverReasons(linux);
  const over = reasons === undefined ? "" : ` · over its limits: ${reasons}`;
  return `Linux online · ${jobs}${cpu}${load}${memory}${over}`;
}

/** "4:05" until the deadline, never negative. */
export function askRemaining(deadlineAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(deadlineAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const ASK_TITLE: Record<NonNullable<HeavyQueueEntry["ask"]>["reason"], string> = {
  unavailable: "Linux is unavailable",
  dropped: "Linux dropped this job mid-run",
};

/** On a waiter whose earlier Linux run may still be alive; rerunning it needs a force. */
export const RUNNER_UNCONFIRMED_NOTE = "Linux has not confirmed the earlier run stopped.";

/**
 * Where a row runs or would run, for a small badge: "Linux · Syncing" on a running Linux job,
 * "Linux" on a waiter headed there. Null on Mac work while the Runner is off.
 */
export function runnerBadge(
  entry: HeavyQueueEntry,
  state: Pick<HeavyQueueState, "linux" | "routes">,
): { readonly runner: HeavyRunner; readonly label: string } | null {
  if (state.linux === null && entry.runner !== "linux") return null;
  if (entry.startedAt !== null) {
    const runner = entry.runner ?? "mac";
    if (runner === "mac") return { runner, label: "This Mac" };
    return {
      runner,
      label: entry.phase === undefined ? "Linux" : `Linux · ${RUNNER_PHASE_LABEL[entry.phase]}`,
    };
  }
  const runner = state.routes[entry.id] ?? "mac";
  return { runner, label: runner === "linux" ? "Linux" : "This Mac" };
}

export interface RouteAction {
  readonly runner: HeavyRunner;
  readonly label: string;
  /** Stops a running job first, or reruns one Linux could not confirm stopped. */
  readonly confirm: string | null;
  readonly force: boolean;
}

/** Routing's own rule: Linux takes a job only with the Runner on and the job not tied to this Mac. */
function mayRunOn(
  entry: HeavyQueueEntry,
  runner: HeavyRunner,
  state: Pick<HeavyQueueState, "linux" | "macOnly">,
): boolean {
  return runner === "mac" || (state.linux !== null && !state.macOnly.includes(entry.id));
}

/** "Run on this Mac" / "Run on Linux" for a row, with the confirmation a running job needs. */
/** What forcing a rerun does while Linux has not confirmed the earlier run stopped. */
const RUNNER_UNCONFIRMED_RERUN: Record<HeavyRunner, string> = {
  mac: "Linux has not confirmed the earlier run stopped. Running it again now may run it twice. Run it anyway?",
  linux:
    "Linux hasn't confirmed the earlier run stopped. T3 stops it before this run starts there; if it can't, this run waits until the earlier one ends. Run it anyway?",
};

export function routeActions(
  entry: HeavyQueueEntry,
  state: Pick<HeavyQueueState, "linux" | "routes" | "macOnly">,
): ReadonlyArray<RouteAction> {
  if (state.linux === null || entry.server === true) return [];
  const running = entry.startedAt !== null;
  const current: HeavyRunner = running
    ? (entry.runner ?? "mac")
    : (state.routes[entry.id] ?? "mac");
  const actions: RouteAction[] = [];
  for (const runner of ["mac", "linux"] as const) {
    if (!mayRunOn(entry, runner, state)) continue;
    // A waiter can always pin where it already heads; a running job only moves elsewhere.
    if (running && runner === current) continue;
    if (!running && runner === current && entry.route === runner) continue;
    const label = runner === "mac" ? "Run on this Mac" : "Run on Linux";
    const confirm = running
      ? `Stop this job and run it again on ${RUNNER_NAME[runner]}? Work it has done so far is lost.`
      : entry.unconfirmed === true
        ? RUNNER_UNCONFIRMED_RERUN[runner]
        : null;
    actions.push({ runner, label, confirm, force: !running && entry.unconfirmed === true });
  }
  return actions;
}

/**
 * A question's answers: both places, even the one it heads for. Linux takes a run it has not
 * confirmed stopped only once it confirms; this Mac, which never shares that run's folder, at once.
 * The row's own action forces Linux.
 */
export function askAnswers(
  entry: HeavyQueueEntry,
  state: Pick<HeavyQueueState, "linux" | "routes" | "macOnly">,
): ReadonlyArray<RouteAction> {
  const { route: _route, unconfirmed: _unconfirmed, ...unpinned } = entry;
  return routeActions(unpinned, state);
}

export interface MoveAllAction {
  readonly runner: HeavyRunner;
  readonly label: string;
}

/**
 * "Move all to this Mac" / "Move all to Linux": offered only while some waiting job would move.
 * Mirrors the server's rule: Linux must be online; running jobs, unconfirmed runs and, for Linux,
 * work tied to this Mac or asked for it stay.
 */
export function moveAllActions(
  state: Pick<HeavyQueueState, "entries" | "linux" | "routes" | "macOnly">,
): ReadonlyArray<MoveAllAction> {
  const moves = (runner: HeavyRunner) =>
    (runner === "mac" || state.linux?.online === true) &&
    state.entries.some(
      (entry) =>
        entry.startedAt === null &&
        entry.server !== true &&
        entry.unconfirmed !== true &&
        (state.routes[entry.id] ?? "mac") !== runner &&
        mayRunOn(entry, runner, state) &&
        !(runner === "linux" && entry.where === "mac"),
    );
  const actions: MoveAllAction[] = [];
  if (moves("mac")) actions.push({ runner: "mac", label: "Move all to this Mac" });
  if (moves("linux")) actions.push({ runner: "linux", label: "Move all to Linux" });
  return actions;
}

interface RunnerModeScope {
  /** Null (targets disagree) counts as applying. */
  readonly applies: (where: RunnerWhere | null) => boolean;
  readonly idle: string;
}

const LINUX_MODE: RunnerModeScope = {
  applies: (where) => where === null || where === "linux",
  idle: "Only applies when Where jobs run is Linux.",
};

/** Every Runner key states whether it depends on the picked mode; null means it applies in all. */
const RUNNER_MODE_SCOPE: Record<RunnerSettingKey, RunnerModeScope | null> = {
  runnerEnabled: null,
  runnerWhere: null,
  runnerUnavailable: null,
  runnerLinuxFull: LINUX_MODE,
  runnerAskMinutes: null,
  runnerDeadlineAction: null,
  runnerDropped: null,
  runnerMacFirstAfter: {
    applies: (where) => where === null || where === "macFirst",
    idle: "Only applies when Where jobs run is Mac first.",
  },
  runnerBringBack: null,
  runnerRouteMemoryDays: null,
  runnerRouteLearnAfter: null,
  runnerBringBackExclude: null,
  runnerBringBackMaxMB: null,
  runnerMacTools: null,
  runnerMacOnly: null,
  runnerHost: null,
  runnerLinuxSlots: null,
  runnerHeartbeatSeconds: null,
  runnerOfflineAfterFailures: null,
  runnerSshTimeoutSeconds: null,
  runnerStopWaitSeconds: null,
  runnerLinuxMemoryFloorPercent: null,
  runnerLinuxCpuCeilingPercent: null,
  runnerLinuxEvictionsBeforeAlone: null,
};

/** Whether a field belongs to the picked mode. */
export function runnerModeFieldApplies(key: RunnerSettingKey, where: RunnerWhere | null): boolean {
  return RUNNER_MODE_SCOPE[key]?.applies(where) ?? true;
}

/** Why a mode-specific field does nothing under the picked mode, or null when it applies. */
export function runnerModeFieldIdle(
  key: RunnerSettingKey,
  where: RunnerWhere | null,
): string | null {
  const scope = RUNNER_MODE_SCOPE[key];
  return scope === null || scope.applies(where) ? null : scope.idle;
}

/** The effective values Runner fields depend on; null where the selected targets disagree. */
export interface RunnerChoices {
  readonly runnerEnabled: boolean | null;
  readonly runnerWhere: RunnerWhere | null;
  readonly runnerUnavailable: RunnerUnavailablePolicy | null;
  readonly runnerDropped: RunnerFailedPolicy | null;
}

/**
 * Why a Runner field does nothing under these choices, or null when it applies. Settings hide such
 * a field, and show it with this note only when a search lands on it. A mixed choice counts as
 * applying, so a field never hides while some selected target still uses it.
 */
export function runnerFieldIdle(key: RunnerSettingKey, choices: RunnerChoices): string | null {
  if (key === "runnerEnabled") return null;
  if (choices.runnerEnabled === false) return "Only applies while the Runner is on.";
  switch (key) {
    case "runnerAskMinutes":
    case "runnerDeadlineAction":
      return [choices.runnerUnavailable, choices.runnerDropped].some(
        (policy) => policy === null || policy === "ask",
      )
        ? null
        : "Only applies when a choice above is Ask me.";
    default:
      return null;
  }
}

/** One line under the "Where heavy work runs" choice, saying what the picked mode does. */
export const RUNNER_WHERE_DESCRIPTION: Record<RunnerWhere, string> = {
  mac: "Everything runs on this Mac. A job's menu can still send it to Linux.",
  macFirst: "Jobs run on this Mac until it has this many running or waiting, then on Linux.",
  automatic:
    "Each job goes to the machine with the shorter queue. Neither starts a job past its own limits.",
  linux:
    "Every job Linux can run goes there. Work that needs this Mac stays here: Always on this Mac, Mac-only tools and local files.",
};

/** The line under "Where heavy work runs". */
export function runnerWhereLine(where: RunnerWhere | null): string {
  return where === null
    ? RUNNER_SETTING_COPY.runnerWhere.description
    : RUNNER_WHERE_DESCRIPTION[where];
}

/** The queue's own limits: passing the head and its lanes; the rest also steer Hybrid on the Mac. */
const QUEUE_ONLY_LIMITS: ReadonlyArray<HeavyQueueLimitKey> = [
  "headPatienceMinutes",
  "quickSeconds",
  "quickSlots",
  "serviceIdleMinutes",
  "reclaimMinutes",
];

export interface HeavyLimitChoices {
  readonly queueEnabled: boolean;
  readonly runnerEnabled: boolean | null;
  readonly runnerWhere: RunnerWhere | null;
}

/**
 * Why a Mac limit does nothing under these choices, or null when it applies. The Mac limits gate
 * the queue and the routing of Hybrid and Mac first; how long a limit must hold also times Linux's limits. Null
 * (targets disagree) counts as applying.
 */
export function heavyLimitIdle(key: HeavyQueueLimitKey, choices: HeavyLimitChoices): string | null {
  if (choices.queueEnabled) return null;
  if (QUEUE_ONLY_LIMITS.includes(key)) return "Only applies while the heavy work queue is on.";
  const runnerOn = choices.runnerEnabled !== false;
  if (key === "heavyOverLimitSeconds") {
    return runnerOn ? null : "Only applies while the heavy work queue or the Runner is on.";
  }
  const where = choices.runnerWhere;
  return runnerOn && (where === null || where === "automatic" || where === "macFirst")
    ? null
    : "Only applies while the heavy work queue is on or jobs run in Hybrid or Mac first.";
}
