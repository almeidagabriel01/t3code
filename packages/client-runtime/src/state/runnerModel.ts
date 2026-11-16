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
  HeavyRunnerPhase,
  RunnerDeadlineAction,
  RunnerFailedPolicy,
  RunnerKey,
  RunnerUnavailablePolicy,
  RunnerWhere,
} from "@t3tools/contracts";

/** Every Runner setting's label and description; web and mobile both read these. */
export const RUNNER_SETTING_COPY: Record<
  RunnerKey,
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
      "This Mac keeps everything here. Mac first fills this Mac, then sends the rest to Linux. Hybrid splits jobs between both. Linux sends the listed commands there.",
  },
  runnerLinuxCommands: {
    title: "Can run on Linux",
    description:
      "A heavy command goes to Linux only when each heavy part of it matches one of these. Builds are left out because their output would stay on the PC.",
  },
  runnerMacOnly: {
    title: "Always on this Mac",
    description:
      "A heavy command that matches one of these always runs on this Mac, even when sent to Linux by hand.",
  },
  runnerUnavailable: {
    title: "When Linux is offline",
    description: "What a job headed for Linux does while Linux is offline.",
  },
  runnerDropped: {
    title: "If a Linux run fails",
    description:
      "What a job does when Linux couldn't run it: the PC went away, or a tool or folder is missing there.",
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
  runnerLinuxEverything: {
    title: "Everything",
    description: "Every heavy command goes to Linux, except what has to stay on this Mac.",
  },
  runnerBringBack: {
    title: "Bring results back",
    description:
      "Copies the files a Linux job created or changed back to this Mac. A file changed here during the job is left alone.",
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
    description: "A new heavy job waits while less than this much of this Mac's memory is free.",
  },
  heavyOverLimitSeconds: {
    title: "Over the limit for",
    description:
      "How long this Mac or Linux must stay past a limit, or back under it, before jobs wait or move. A short spike changes nothing.",
  },
};

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
  readonly everything: boolean;
}

/** One sentence for the current queue × Runner combination; both settings sections show it. */
export function heavyModeLine(mode: HeavyModeInput): string {
  const { queueEnabled, queuePaused, runnerEnabled, where, everything } = mode;
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
        return everything
          ? "Heavy commands run on Linux; what has to stay here waits its turn on this Mac."
          : "Listed commands run on Linux; everything else waits its turn on this Mac.";
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
      return everything
        ? "No queue: heavy commands wait for a Linux slot; what has to stay here starts right away."
        : "No queue: listed commands wait for a Linux slot, the rest start here right away.";
    case "automatic":
      return RUNNER_WHERE_DESCRIPTION.automatic;
    case "macFirst":
      return RUNNER_WHERE_DESCRIPTION.macFirst;
  }
}

const GB = 1024 ** 3;

/** "Linux online · 1 of 2 running · load 1.2 on 6 cores · 8.1 GB free", or why it is not. */
export function linuxLine(linux: HeavyRunnerLinux): string {
  const jobs = `${linux.running} of ${linux.slots} running`;
  if (linux.online === null) return `Checking Linux (${linux.host})…`;
  if (!linux.online) {
    return `Linux offline${linux.error === undefined ? "" : `: ${linux.error}`}`;
  }
  const load =
    linux.load1 === null
      ? ""
      : ` · load ${linux.load1.toFixed(1)}${linux.cpuCount === null ? "" : ` on ${linux.cpuCount} cores`}`;
  const memory =
    linux.availableMemoryBytes === null
      ? ""
      : ` · ${(linux.availableMemoryBytes / GB).toFixed(1)} GB free`;
  return `Linux online · ${jobs}${load}${memory}`;
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
        ? "Linux has not confirmed the earlier run stopped. Running it again now may run it twice. Run it anyway?"
        : null;
    actions.push({ runner, label, confirm, force: !running && entry.unconfirmed === true });
  }
  return actions;
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

/** Linux mode with Everything on: every heavy command may go, so the Linux list does nothing. */
export function runnerEverythingOn(where: RunnerWhere | null, everything: boolean | null): boolean {
  return where === "linux" && everything === true;
}

/**
 * Whether a mode-specific field belongs to the picked mode, and the Linux list to Linux mode only
 * while Everything is off. Null (targets disagree) counts as applying.
 */
export function runnerModeFieldApplies(
  key: RunnerKey,
  where: RunnerWhere | null,
  everything: boolean | null,
): boolean {
  if (key === "runnerMacFirstAfter") return where === null || where === "macFirst";
  if (key === "runnerLinuxEverything") return where === null || where === "linux";
  if (key === "runnerLinuxCommands") return !runnerEverythingOn(where, everything);
  return true;
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
export function runnerFieldIdle(key: RunnerKey, choices: RunnerChoices): string | null {
  if (key === "runnerEnabled") return null;
  if (choices.runnerEnabled === false) return "Only applies while the Runner is on.";
  switch (key) {
    case "runnerLinuxCommands":
      return choices.runnerWhere === "mac"
        ? "Only applies when jobs run on Linux or Hybrid."
        : null;
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
  linux: "Listed commands always run on Linux. Everything else stays on this Mac.",
};

/** The line under "Where heavy work runs"; with Everything on it says what Everything does. */
export function runnerWhereLine(where: RunnerWhere | null, everything: boolean | null): string {
  if (where === null) return RUNNER_SETTING_COPY.runnerWhere.description;
  return runnerEverythingOn(where, everything)
    ? RUNNER_SETTING_COPY.runnerLinuxEverything.description
    : RUNNER_WHERE_DESCRIPTION[where];
}

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
  const runnerOn = choices.runnerEnabled !== false;
  if (key === "heavyOverLimitSeconds") {
    return runnerOn ? null : "Only applies while the heavy work queue or the Runner is on.";
  }
  const where = choices.runnerWhere;
  return runnerOn && (where === null || where === "automatic" || where === "macFirst")
    ? null
    : "Only applies while the heavy work queue is on or jobs run in Hybrid or Mac first.";
}
