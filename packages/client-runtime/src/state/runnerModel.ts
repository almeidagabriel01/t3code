/**
 * Runner wording and decisions both clients show: the line that says what the queue and the
 * Runner do together, the Linux status, a row's runner and phase, and its move actions.
 */
import type {
  HeavyQueueEntry,
  HeavyQueueState,
  HeavyRunner,
  HeavyRunnerLinux,
  HeavyRunnerPhase,
  RunnerDeadlineAction,
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
      "This Mac keeps everything here. Linux sends the listed commands there. Automatic keeps work here until this Mac has the number of jobs below, then sends listed commands to Linux.",
  },
  runnerOverflow: {
    title: "Send to Linux after",
    description:
      "Automatic sends work to Linux once this Mac has this many heavy jobs, running and waiting.",
  },
  runnerLinuxCommands: {
    title: "Commands that may run on Linux",
    description:
      "One per line. A heavy command goes to Linux only when each heavy part of it matches one. Builds are left out because their output would stay on the PC.",
  },
  runnerMacOnly: {
    title: "Commands that stay on this Mac",
    description:
      "One per line. A heavy command that matches one always runs on this Mac, such as simulators and native builds.",
  },
  runnerUnavailable: {
    title: "When Linux is offline",
    description: "What a job headed for Linux does while Linux is offline.",
  },
  runnerDropped: {
    title: "When Linux drops a job",
    description: "What a job does when Linux goes away while it runs there.",
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
};

export const RUNNER_WHERE_LABEL: Record<RunnerWhere, string> = {
  mac: "This Mac",
  linux: "Linux",
  automatic: "Automatic",
};

export const RUNNER_POLICY_LABEL: Record<RunnerUnavailablePolicy, string> = {
  ask: "Ask me",
  mac: "Run on this Mac",
  wait: "Wait for Linux",
};

export const RUNNER_DEADLINE_LABEL: Record<RunnerDeadlineAction, string> = {
  mac: "Run on this Mac",
  wait: "Wait for Linux",
  cancel: "Cancel",
};

const RUNNER_PHASE_LABEL: Record<HeavyRunnerPhase, string> = {
  syncing: "Syncing",
  installing: "Installing deps",
  running: "Running",
};

const RUNNER_NAME: Record<HeavyRunner, string> = { mac: "this Mac", linux: "Linux" };

export interface HeavyModeInput {
  readonly queueEnabled: boolean;
  readonly queuePaused: boolean;
  readonly runnerEnabled: boolean;
  readonly where: RunnerWhere;
  readonly overflow: number;
}

/** One sentence for the current queue × Runner combination; both settings sections show it. */
export function heavyModeLine(mode: HeavyModeInput): string {
  const { queueEnabled, queuePaused, runnerEnabled, where, overflow } = mode;
  if (!runnerEnabled) {
    if (!queueEnabled) return "Heavy jobs start right away, with nothing tracking them.";
    return queuePaused
      ? "Queue paused: nothing new starts on this Mac."
      : "Heavy jobs wait their turn on this Mac.";
  }
  if (queueEnabled && queuePaused) return "Queue paused: nothing new starts on this Mac or Linux.";
  const jobs = `${overflow} ${overflow === 1 ? "job" : "jobs"}`;
  if (queueEnabled) {
    switch (where) {
      case "mac":
        return "Heavy jobs wait their turn on this Mac; nothing goes to Linux.";
      case "linux":
        return "Listed commands run on Linux; everything else waits its turn on this Mac.";
      case "automatic":
        return `Heavy jobs queue on this Mac; past ${jobs}, listed commands go to Linux.`;
    }
  }
  switch (where) {
    case "mac":
      return "No queue: heavy jobs start on this Mac right away.";
    case "linux":
      return "No queue: listed commands wait for a Linux slot, the rest start here right away.";
    case "automatic":
      return `No queue: jobs start here right away until ${jobs} run, then listed commands go to Linux.`;
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
  const canLinux = !state.macOnly.includes(entry.id);
  const actions: RouteAction[] = [];
  for (const runner of ["mac", "linux"] as const) {
    if (runner === "linux" && !canLinux) continue;
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
