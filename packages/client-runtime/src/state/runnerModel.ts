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
  RunnerUnavailablePolicy,
  RunnerWhere,
} from "@t3tools/contracts";

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

export const RUNNER_PHASE_LABEL: Record<HeavyRunnerPhase, string> = {
  syncing: "Syncing",
  installing: "Installing deps",
  running: "Running",
};

export const RUNNER_NAME: Record<HeavyRunner, string> = { mac: "this Mac", linux: "Linux" };

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
