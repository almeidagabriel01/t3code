/**
 * The Runner's pure decisions: whether heavy work is intercepted at all, where each waiter goes
 * (this Mac or Linux), how Linux health moves between online and offline, and how a `remoto`
 * run ended. The queue file, the CLI, the hook and the server all decide through these.
 */
import {
  RUNNER_DEFAULTS,
  type HeavyQueueEntry,
  type HeavyRunner,
  type HeavyRunnerAskReason,
  type RunnerMachineConfig,
  type RunnerProjectConfig,
} from "@t3tools/contracts";

import { kindOf, plan, type Plan, type PlanInput } from "./admission.ts";
import { heavySegments } from "./heavyHook.ts";

export const DEFAULT_PROJECT_CONFIG: RunnerProjectConfig = {
  runnerEnabled: RUNNER_DEFAULTS.runnerEnabled,
  runnerWhere: RUNNER_DEFAULTS.runnerWhere,
  runnerOverflow: RUNNER_DEFAULTS.runnerOverflow,
  runnerUnavailable: RUNNER_DEFAULTS.runnerUnavailable,
  runnerAskMinutes: RUNNER_DEFAULTS.runnerAskMinutes,
  runnerDeadlineAction: RUNNER_DEFAULTS.runnerDeadlineAction,
  runnerDropped: RUNNER_DEFAULTS.runnerDropped,
  runnerMacOnly: RUNNER_DEFAULTS.runnerMacOnly,
  runnerLinuxCommands: RUNNER_DEFAULTS.runnerLinuxCommands,
};

export const DEFAULT_MACHINE_CONFIG: RunnerMachineConfig = {
  runnerHost: RUNNER_DEFAULTS.runnerHost,
  runnerLinuxSlots: RUNNER_DEFAULTS.runnerLinuxSlots,
  runnerHeartbeatSeconds: RUNNER_DEFAULTS.runnerHeartbeatSeconds,
  runnerOfflineAfterFailures: RUNNER_DEFAULTS.runnerOfflineAfterFailures,
  runnerSshTimeoutSeconds: RUNNER_DEFAULTS.runnerSshTimeoutSeconds,
  runnerStopWaitSeconds: RUNNER_DEFAULTS.runnerStopWaitSeconds,
};

/** What a T3 server publishes into the queue file from its settings. */
export interface RunnerBlock {
  readonly global: RunnerProjectConfig;
  readonly machine: RunnerMachineConfig;
  /** Each project's effective settings, by its workspace root. */
  readonly projects: ReadonlyArray<{ readonly root: string; readonly config: RunnerProjectConfig }>;
  readonly publisher: {
    readonly pid: number;
    readonly home: string;
    /** Published from the default T3 home, which outranks dev servers sharing the queue. */
    readonly primary: boolean;
  };
}

/** Whether `next` may replace the block in the file; a dev server never overrides the live app. */
export const mayPublish = (
  current: RunnerBlock | null,
  next: RunnerBlock["publisher"],
  isAlive: (pid: number) => boolean,
) =>
  current === null ||
  current.publisher.home === next.home ||
  !isAlive(current.publisher.pid) ||
  (next.primary && !current.publisher.primary);

const trimRoot = (path: string) => path.replace(/[\\/]+$/, "");
const inside = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);

/**
 * The settings for work in `cwd`: the deepest project folder holding it or one of its `aliases`
 * (the same folder in the main checkout, for a git worktree elsewhere) wins, else the global ones.
 */
export const runnerConfigFor = (
  block: RunnerBlock | null,
  cwd: string,
  aliases: ReadonlyArray<string> = [],
): RunnerProjectConfig => {
  if (block === null) return DEFAULT_PROJECT_CONFIG;
  const paths = [cwd, ...aliases].map(trimRoot);
  let best: RunnerBlock["projects"][number] | undefined;
  for (const project of block.projects) {
    const root = trimRoot(project.root);
    if (!paths.some((path) => inside(path, root))) continue;
    if (best === undefined || root.length > trimRoot(best.root).length) best = project;
  }
  return best?.config ?? block.global;
};

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern is words that must appear in order as whole words: `*` matches within a word, and a
 * word may sit after a path separator or a script prefix (`test` matches `vp test`, `test:e2e`
 * and `pnpm run test`, not `latest`), so a test file name matches its path too.
 */
const patternRegex = (pattern: string) =>
  new RegExp(
    `(^|[\\s/'"=:])${pattern
      .trim()
      .split(/\s+/)
      .map((word) => escape(word).replaceAll("*", "\\S*"))
      .join("\\s+")}(?=$|[\\s:'"])`,
    "i",
  );

export const matchesAny = (text: string, patterns: ReadonlyArray<string>) =>
  patterns.some((pattern) => pattern.trim() !== "" && patternRegex(pattern).test(text));

export type Eligibility = "linux" | "exclusive" | "mac-only" | "not-listed";

/** Exclusive and Mac-only work never leaves the Mac; Linux takes only what every heavy part lists. */
export const eligibilityOf = (
  entry: Pick<HeavyQueueEntry, "label" | "server">,
  config: RunnerProjectConfig,
): Eligibility => {
  if (kindOf(entry) === "exclusive") return "exclusive";
  if (matchesAny(entry.label, config.runnerMacOnly)) return "mac-only";
  const segments = heavySegments(entry.label);
  const parts = segments.length === 0 ? [entry.label] : segments;
  return parts.every((part) => matchesAny(part, config.runnerLinuxCommands))
    ? "linux"
    : "not-listed";
};

export interface LinuxHealth {
  /** Null until a check settles it. */
  readonly online: boolean | null;
  readonly failures: number;
  readonly checkedAt: number | null;
  /** The last successful check. */
  readonly okAt: number | null;
  readonly load1: number | null;
  readonly cpuCount: number | null;
  readonly availableMemoryBytes: number | null;
  readonly totalMemoryBytes: number | null;
  readonly error?: string;
}

export const UNKNOWN_HEALTH: LinuxHealth = {
  online: null,
  failures: 0,
  checkedAt: null,
  okAt: null,
  load1: null,
  cpuCount: null,
  availableMemoryBytes: null,
  totalMemoryBytes: null,
};

export interface LinuxReading {
  readonly load1: number | null;
  readonly cpuCount: number | null;
  readonly availableMemoryBytes: number | null;
  readonly totalMemoryBytes: number | null;
}

/** `cat /proc/loadavg; nproc; free -b` output. */
export const parseHeartbeat = (text: string): LinuxReading => {
  const lines = text.split("\n");
  const load1 = Number(lines[0]?.trim().split(/\s+/)[0]);
  const cpuCount = Number(lines[1]?.trim());
  const mem = lines
    .find((line) => line.startsWith("Mem:"))
    ?.trim()
    .split(/\s+/);
  const total = Number(mem?.[1]);
  const available = Number(mem?.[6]);
  const value = (n: number) => (Number.isFinite(n) ? n : null);
  return {
    load1: value(load1),
    cpuCount: Number.isInteger(cpuCount) && cpuCount > 0 ? cpuCount : null,
    totalMemoryBytes: value(total),
    availableMemoryBytes: value(available),
  };
};

export type HealthCheck =
  | { readonly ok: true; readonly reading: LinuxReading }
  | { readonly ok: false; readonly error: string };

/** Offline after `failuresToOffline` failures in a row, online again after one success. */
export const nextHealth = (
  previous: LinuxHealth,
  check: HealthCheck,
  failuresToOffline: number,
  now: number,
): LinuxHealth => {
  if (check.ok) return { online: true, failures: 0, checkedAt: now, okAt: now, ...check.reading };
  const failures = previous.failures + 1;
  return {
    ...previous,
    online: failures >= failuresToOffline ? false : previous.online,
    failures,
    checkedAt: now,
    error: check.error,
  };
};

/** Linux can take this entry: the heartbeat says online and no `remoto` failed it since. */
const linuxUpFor = (health: LinuxHealth, entry: HeavyQueueEntry) =>
  health.online === true &&
  (entry.linuxFailedAt === undefined || (health.okAt ?? 0) > entry.linuxFailedAt);

export interface WorkContext {
  readonly config: RunnerProjectConfig;
  /** Two jobs of one worktree never run on Linux together: `remoto` would serialize them. */
  readonly worktree: string;
}

export interface RoutePlanInput extends PlanInput {
  readonly contextOf: (cwd: string) => WorkContext;
  readonly machine: RunnerMachineConfig;
  readonly health: LinuxHealth;
}

export interface Admit {
  readonly runner: HeavyRunner;
  /** The queue is off: no admission gate, worker cap or QoS. */
  readonly ungated: boolean;
}

export interface RoutePlan {
  readonly admits: Readonly<Record<string, Admit>>;
  /** Where each waiter would go if a slot opened now. */
  readonly routes: Readonly<Record<string, HeavyRunner>>;
  readonly reasons: Readonly<Record<string, string>>;
  /** Waiters that must ask the user now (they have no question yet). */
  readonly asks: Readonly<Record<string, HeavyRunnerAskReason>>;
  /** Waiters whose unanswered question ended in Cancel. */
  readonly cancels: Readonly<Record<string, string>>;
  readonly room: boolean;
  readonly holding: boolean;
  readonly mac: Plan | null;
}

const askExpired = (entry: HeavyQueueEntry, now: number) =>
  entry.ask !== undefined && Date.parse(entry.ask.deadlineAt) <= now;

/** Where the entry's own settings send it before Linux health is considered. */
const intentOf = (
  entry: HeavyQueueEntry,
  config: RunnerProjectConfig,
): "mac" | "linux" | "automatic" => {
  if (!config.runnerEnabled || entry.forced === true) return "mac";
  const eligibility = eligibilityOf(entry, config);
  if (eligibility === "exclusive" || eligibility === "mac-only") return "mac";
  if (entry.route !== undefined) return entry.route;
  // `--runner` (an agent's own `remoto` call) speaks for the job; otherwise only listed work leaves.
  if (entry.where !== undefined) return entry.where;
  return eligibility === "linux" ? config.runnerWhere : "mac";
};

/**
 * Decides every waiter for both runners. Mac waiters go through `plan` (or start at once with the
 * queue off); Linux waiters take free Linux slots, one per worktree. Automatic sends a waiter to
 * Linux once N jobs are running or waiting on the Mac ahead of it, and keeps it on the Mac when
 * Linux is full or offline.
 */
export const planRoutes = (input: RoutePlanInput): RoutePlan => {
  const { entries, now, health, machine } = input;
  const queueOn = input.enabled;
  const paused = queueOn && input.paused;
  const running = entries.filter((entry) => entry.startedAt !== null);
  const waiting = entries.filter((entry) => entry.startedAt === null);
  const linuxRunning = running.filter((entry) => entry.runner === "linux");
  const macRunning = running.filter((entry) => entry.runner !== "linux");
  const busyWorktrees = new Set(linuxRunning.map((entry) => input.contextOf(entry.cwd).worktree));
  let linuxFree = machine.runnerLinuxSlots - linuxRunning.length;
  let macCount = macRunning.length;

  const admits: Record<string, Admit> = {};
  const routes: Record<string, HeavyRunner> = {};
  const reasons: Record<string, string> = {};
  const asks: Record<string, HeavyRunnerAskReason> = {};
  const cancels: Record<string, string> = {};
  const macWaiters: HeavyQueueEntry[] = [];

  const toMac = (entry: HeavyQueueEntry) => {
    routes[entry.id] = "mac";
    macCount += 1;
    if (queueOn) macWaiters.push(entry);
    else admits[entry.id] = { runner: "mac", ungated: true };
  };
  /** A Linux slot now, or null with why not. */
  const linuxSlot = (entry: HeavyQueueEntry, worktree: string): string | null => {
    if (linuxFree <= 0) return `all ${machine.runnerLinuxSlots} Linux slots are busy`;
    if (busyWorktrees.has(worktree)) return "this worktree is already running on Linux";
    linuxFree -= 1;
    busyWorktrees.add(worktree);
    admits[entry.id] = { runner: "linux", ungated: !queueOn };
    return null;
  };

  for (const entry of waiting) {
    const { config, worktree } = input.contextOf(entry.cwd);
    if (entry.unconfirmed === true) {
      routes[entry.id] = entry.route ?? "linux";
      reasons[entry.id] = "Linux dropped it mid-run: confirming it stopped there before rerunning";
      continue;
    }
    const intent = intentOf(entry, config);
    if (intent === "mac") {
      toMac(entry);
      continue;
    }
    const up = linuxUpFor(health, entry);
    if (intent === "automatic") {
      if (macCount < config.runnerOverflow || !up || paused) {
        toMac(entry);
        continue;
      }
      const why = linuxSlot(entry, worktree);
      if (why === null) routes[entry.id] = "linux";
      else toMac(entry);
      continue;
    }
    // Bound for Linux.
    routes[entry.id] = "linux";
    if (paused) {
      reasons[entry.id] = "paused";
      continue;
    }
    if (up) {
      const why = linuxSlot(entry, worktree);
      if (why !== null) reasons[entry.id] = `waiting for Linux: ${why}`;
      continue;
    }
    if (health.online === null && entry.linuxFailedAt === undefined) {
      reasons[entry.id] = "checking whether Linux is up";
      continue;
    }
    // The user (or an expired question) already chose to wait.
    if (entry.route === "linux") {
      reasons[entry.id] = "waiting for Linux to come back";
      continue;
    }
    const reason: HeavyRunnerAskReason = entry.dropped === true ? "dropped" : "unavailable";
    const policy = reason === "dropped" ? config.runnerDropped : config.runnerUnavailable;
    const what = reason === "dropped" ? "Linux dropped it mid-run" : "Linux is unavailable";
    if (policy === "mac") {
      toMac(entry);
      continue;
    }
    if (policy === "wait") {
      reasons[entry.id] = `${what}: waiting for it`;
      continue;
    }
    if (entry.ask === undefined) {
      asks[entry.id] = reason;
      reasons[entry.id] = `${what}: asking you`;
      continue;
    }
    if (!askExpired(entry, now)) {
      reasons[entry.id] = `${what}: waiting for your answer`;
      continue;
    }
    if (config.runnerDeadlineAction === "mac") toMac(entry);
    else if (config.runnerDeadlineAction === "wait") {
      reasons[entry.id] = `${what}: no answer, waiting for it`;
    } else cancels[entry.id] = `${what} and nobody answered in time: canceled`;
  }

  if (!queueOn) {
    return { admits, routes, reasons, asks, cancels, room: true, holding: false, mac: null };
  }
  const mac = plan({ ...input, entries: [...macRunning, ...macWaiters] });
  if (mac.admit !== null) admits[mac.admit] = { runner: "mac", ungated: false };
  return {
    admits,
    routes,
    reasons: { ...mac.reasons, ...reasons },
    asks,
    cancels,
    room: mac.room,
    holding: mac.holding,
    mac,
  };
};

/** Stderr lines `remoto` prints with `REMOTO_MARKERS=1`; people never see them. */
export const MARKER = "\u001eremoto ";

export interface RemoteProgress {
  readonly syncing: boolean;
  readonly running: boolean;
  readonly phase: "syncing" | "installing" | "running" | null;
  readonly id: string | null;
  readonly pgid: number | null;
  readonly exit: number | null;
}

export const NO_PROGRESS: RemoteProgress = {
  syncing: false,
  running: false,
  phase: null,
  id: null,
  pgid: null,
  exit: null,
};

/** Folds one marker line (`phase=running pgid=123`, `exit=0`) into the progress so far. */
export const foldMarker = (progress: RemoteProgress, line: string): RemoteProgress => {
  const fields = Object.fromEntries(
    line
      .slice(MARKER.length)
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split("=") as [string, string | undefined]),
  );
  const phase = fields.phase;
  const int = (value: string | undefined) =>
    value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
  return {
    syncing: progress.syncing || phase === "syncing",
    running: progress.running || phase === "running",
    phase:
      phase === "syncing" || phase === "installing" || phase === "running" ? phase : progress.phase,
    id:
      typeof fields.id === "string" && /^[A-Za-z0-9._-]+$/.test(fields.id)
        ? fields.id
        : progress.id,
    pgid: int(fields.pgid) ?? progress.pgid,
    exit: int(fields.exit) ?? progress.exit,
  };
};

export type RemoteOutcome =
  | { readonly kind: "finished"; readonly code: number }
  /** The command never started there; `touched` when `remoto` got as far as syncing. */
  | { readonly kind: "unavailable"; readonly touched: boolean }
  /** It started there and the connection ended without its exit code. */
  | { readonly kind: "dropped" };

/** The exit marker is the command's own code; without it, ssh's 255 is not the command's. */
export const remoteOutcome = (progress: RemoteProgress): RemoteOutcome => {
  if (progress.exit !== null) return { kind: "finished", code: progress.exit };
  if (!progress.running) return { kind: "unavailable", touched: progress.syncing };
  return { kind: "dropped" };
};

/** Extra ssh options from `REMOTO_SSH_OPTS`, shared with `remoto` so both reach the same host. */
const sshOptions = (environment: Readonly<Record<string, string | undefined>>) =>
  (environment.REMOTO_SSH_OPTS ?? "").split(/\s+/).filter((word) => word !== "");

export const sshArgs = (
  machine: RunnerMachineConfig,
  environment: Readonly<Record<string, string | undefined>>,
  command: string,
) => [
  "-o",
  `ConnectTimeout=${machine.runnerSshTimeoutSeconds}`,
  "-o",
  "BatchMode=yes",
  ...sshOptions(environment),
  machine.runnerHost,
  command,
];

export const HEARTBEAT_COMMAND = "cat /proc/loadavg; nproc; free -b";

/**
 * Stops what is left of run `id` there: its process group, then anything still naming its
 * folder. TERM, up to `waitSeconds` for it to go, then KILL. Prints `gone` when nothing ran,
 * `stopped` or `killed` when it is gone now, and `alive` (exit 1) when it survived.
 */
export const remoteStopScript = (id: string, pgid: number | null, waitSeconds: number) => {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe run id: ${id}`);
  // `[r]uns/…` keeps the pattern from matching the shell running this very script.
  const pattern = `[r]uns/${id}( |/|$)`;
  return [
    `p=${pgid ?? ""}; [ -n "$p" ] || p=$(cat "runs/${id}.pgid" 2>/dev/null)`,
    `alive() { { [ -n "$p" ] && kill -0 -- "-$p"; } 2>/dev/null || pgrep -f '${pattern}' >/dev/null; }`,
    `alive || { echo gone; exit 0; }`,
    `{ [ -n "$p" ] && kill -TERM -- "-$p"; pkill -TERM -f '${pattern}'; } 2>/dev/null`,
    `i=0; while alive && [ "$i" -lt ${Math.max(1, Math.floor(waitSeconds))} ]; do sleep 1; i=$((i+1)); done`,
    `alive || { echo stopped; exit 0; }`,
    `{ [ -n "$p" ] && kill -KILL -- "-$p"; pkill -KILL -f '${pattern}'; } 2>/dev/null; sleep 1`,
    `if alive; then echo alive; exit 1; else echo killed; fi`,
  ].join("\n");
};

/** Lines of a failed Linux run that name files on the Mac-only list: they fail there by nature. */
export const platformFailures = (output: string, macOnly: ReadonlyArray<string>) => {
  const files = macOnly.filter((pattern) => /[/.]/.test(pattern));
  if (files.length === 0) return [];
  return [
    ...new Set(
      output
        .split("\n")
        .filter((line) => matchesAny(line, files))
        .map((line) => line.trim()),
    ),
  ].slice(0, 10);
};
