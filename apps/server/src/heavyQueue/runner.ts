/**
 * The Runner's pure decisions: whether heavy work is intercepted at all, where each waiter goes
 * (this Mac or Linux), how Linux health moves between online and offline, and how a `remoto`
 * run ended. The queue file, the CLI, the hook and the server all decide through these.
 */
import {
  HEAVY_SLOW_AGENT_JOBS_DEFAULT,
  RUNNER_DEFAULTS,
  type HeavyQueueEntry,
  type HeavyRunner,
  type HeavyRunnerAskReason,
  type RunnerMachineConfig,
  type RunnerProjectConfig,
} from "@t3tools/contracts";

import {
  jobVerdict,
  kindOf,
  machineHold,
  plan,
  SAMPLE_FRESH_MS,
  sustain,
  type Plan,
  type PlanInput,
  type Sustained,
} from "./admission.ts";
import { commitOnly, nameOf, readLine, workParts, type Part } from "./heavyHook.ts";
import type { Redirect, Word } from "./shellLine.ts";

export const DEFAULT_PROJECT_CONFIG: RunnerProjectConfig = {
  runnerEnabled: RUNNER_DEFAULTS.runnerEnabled,
  runnerWhere: RUNNER_DEFAULTS.runnerWhere,
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
  runnerLinuxMemoryFloorPercent: RUNNER_DEFAULTS.runnerLinuxMemoryFloorPercent,
  runnerLinuxCpuCeilingPercent: RUNNER_DEFAULTS.runnerLinuxCpuCeilingPercent,
  heavySlowAgentJobs: HEAVY_SLOW_AGENT_JOBS_DEFAULT,
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

export interface Verdict {
  readonly eligibility: Eligibility;
  /** For people, on the Resource Manager row; null when Linux can take it. */
  readonly reason: string | null;
}

/**
 * Fields only the queue file keeps: a job's full command line (the label is cut short for the
 * row) and why a Linux attempt sent it back to this Mac.
 */
export type QueuedEntry = HeavyQueueEntry & {
  readonly line?: string;
  readonly routeReason?: string;
};
const lineOf = (entry: Pick<QueuedEntry, "label" | "line">) => entry.line ?? entry.label;

/** A Mac path resolved the way the shell would, without touching the disk. */
const resolvePath = (from: string, to: string) => {
  const out: string[] = [];
  for (const part of (to.startsWith("/") ? to : `${from}/${to}`).split("/")) {
    if (part === "..") out.pop();
    else if (part !== "" && part !== ".") out.push(part);
  }
  return `/${out.join("/")}`;
};

/** A word as the shell will pass it, or the expansion only this Mac can resolve. */
const expand = (
  word: Word,
  vars: ReadonlyMap<string, string | null>,
  cwd: string,
): { readonly value: string } | { readonly unknown: string } => {
  let value = word.tilde ? word.value.replace(/^~(?=\/|$)/, vars.get("HOME") ?? "~") : word.value;
  for (const name of word.vars) {
    if (name === "") return { unknown: "$(…)" };
    const known = name === "PWD" ? cwd : vars.get(name);
    if (known === null || known === undefined) return { unknown: `$${name}` };
    value = value.replace(new RegExp(String.raw`\$\{${name}\}|\$${name}(?!\w)`, "g"), () => known);
  }
  return { value };
};

/** Devices Linux has too, so naming them ties nothing here. */
const SHARED = /^\/dev\//;

/**
 * Why an argument ties its part to this Mac: an absolute or `..` path (alone or as
 * `--flag=<path>`) outside the checkout Linux gets a copy of. Null when it ties nothing.
 */
export const outsideTie = (arg: string, cwd: string, root: string): string | null => {
  const flagValue = /^-[\w.-]*=(.+)$/.exec(arg)?.[1];
  for (const candidate of [arg, flagValue]) {
    if (candidate === undefined || !/^(\/|\.\.(\/|$))/.test(candidate)) continue;
    const path = resolvePath(cwd, candidate);
    if (!inside(path, root) && !SHARED.test(path))
      return `Uses a file outside the project: ${path}`;
  }
  return null;
};

/** Why a commit waits in the queue at all; with the Runner on, the Runner's own reason shows. */
const COMMIT_HOOK = "Commit hook runs checks";

export const NEEDS_GIT = "Needs git, which the Linux copy doesn't have";

// ponytail: words only; a script that calls git inside (`ci.sh`) can't be seen from its line.
const GIT_DRIVEN = /(^|[^a-z])(only)?(changed|staged)(since)?($|[^a-z])/i;

/**
 * Whether a command needs the repository's history, which `remoto` leaves out of the Linux copy:
 * git itself, or a flag, script or subcommand that diffs against it (`--changed`, `--onlyChanged`,
 * `check:changed`, `vp staged`). Paths, a flag's value (`-t staged`) and free text are skipped.
 */
export const needsGit = (values: ReadonlyArray<string>) =>
  values[0]?.split("/").pop() === "git" ||
  values.some((value, at) => {
    // The Runner computes its changed files here and hands them over (`changedInputs`).
    if (value === "check:changed") return false;
    const flag = value.startsWith("-");
    if (!flag && (values[at - 1]?.startsWith("-") || /[\s/.]/.test(value))) return false;
    return GIT_DRIVEN.test(flag ? value.replace(/=.*$/, "") : value);
  });

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "vp", "deno"]);
const INSTALLS = /^(install|i|add|remove|rm|uninstall|un|update|up|upgrade|ci|link|unlink|dedupe)$/;
const DEV_SERVER = /^(dev|start|serve|watch|preview)([:._-].*)?$/;
const DEV_PROGRAMS: Readonly<Record<string, RegExp>> = {
  vite: /^(dev|serve|preview)?$/,
  next: /^(dev|start)$/,
  expo: /^start$/,
};
const EXECUTORS = new Set(["npx", "pnpx", "bunx"]);
const EXEC = /^(exec|dlx|x)$/;
const MAC_TOOLS = new Set(["xcodebuild", "xcrun", "simctl", "emulator", "adb", "instruments"]);

/**
 * Work that stays here in every mode, whatever the lists say: installs (the lockfile and
 * `node_modules` are this Mac's), Xcode, simulator and emulator tools, and dev servers.
 */
const alwaysMac = (part: Part): boolean => {
  let { program, words } = part;
  // `npx vite`, `pnpm exec next dev`: the tool they run decides.
  if (EXECUTORS.has(program) || (PACKAGE_MANAGERS.has(program) && EXEC.test(words[0] ?? ""))) {
    const at = EXECUTORS.has(program) ? 0 : 1;
    program = words[at]?.split("/").pop() ?? "";
    words = words.slice(at + 1);
  }
  const [first = "", second = ""] = words;
  if (MAC_TOOLS.has(program)) return true;
  if (program === "expo" && first.startsWith("run")) return true;
  if (DEV_PROGRAMS[program]?.test(first) === true) return true;
  if (!PACKAGE_MANAGERS.has(program)) return false;
  const script = first === "run" || first === "run-script" ? second : first;
  // `pnpm --filter web add x`: a flag's value can sit before the subcommand.
  return INSTALLS.test(first) || INSTALLS.test(second) || DEV_SERVER.test(script);
};

/**
 * Why one part of the work must run on this Mac, or null when Linux can run it from `cwd`. What
 * only the shell knows (a variable set elsewhere, `$(…)`, `cd $d`) passes here: `linux-part`
 * checks the expanded command and folder again before anything leaves.
 */
const tieOf = (
  part: Part,
  cwd: string | null,
  vars: ReadonlyMap<string, string | null>,
  rootOf: (cwd: string) => string | null,
  config: RunnerProjectConfig,
): string | null => {
  const text = part.values.slice(part.remoteAt).join(" ");
  const pattern = config.runnerMacOnly.find((each) => matchesAny(text, [each]));
  if (pattern !== undefined) return `Always on this Mac: ${pattern.trim()}`;
  if (alwaysMac(part)) return `Always on this Mac: ${nameOf(text)}`;
  if (part.program === "git" && part.words[0] === "commit") {
    return "Commits run here: the pre-commit edits this Mac's repository";
  }
  if (part.program === "git" || needsGit(part.values.slice(part.remoteAt))) return NEEDS_GIT;
  // Its own redirects and pipes would run there too.
  if (part.nested !== null) return "Couldn't read this command safely (nested shell)";
  const { command } = part;
  // The job's one slot, Stop and requeue follow a single run at a time.
  if (command.next === "&") return `Runs in the background: ${nameOf(text)}`;
  // `remoto` gives the command no input there, which is all `< /dev/null` asks for.
  const reads = (redirect: Redirect) =>
    redirect.op.includes("<") &&
    !(redirect.op.endsWith("<") && redirect.target?.value === "/dev/null");
  if (command.piped || command.redirects.some(reads)) {
    return `Reads its input from this Mac: ${nameOf(text)}`;
  }
  if (cwd === null) return null;
  // `remoto` syncs the checkout it runs from, so each part is judged against its own.
  const root = rootOf(cwd);
  if (root === null) return `Runs outside a git checkout: ${cwd}`;
  for (const word of part.command.words.slice(part.programAt + 1)) {
    const expanded = expand(word, vars, cwd);
    const tie = "value" in expanded ? outsideTie(expanded.value, cwd, root) : null;
    if (tie !== null) return tie;
  }
  return null;
};

const literalValue = (word: Word, vars: ReadonlyMap<string, string | null>, cwd: string) => {
  const expanded = expand(word, vars, cwd);
  return "value" in expanded ? expanded.value : null;
};

const DECLARES = new Set(["export", "declare", "local", "readonly"]);

/**
 * Whether Linux can run a job, and why not. Only the work parts leave (heavy commands and
 * `remoto` calls); the rest of the line runs here, so only they are judged, each from the folder
 * it runs in. Every part must pass, else the whole job stays and the reason names the part.
 */
export const eligibilityOf = (
  entry: Pick<QueuedEntry, "label" | "line" | "server" | "cwd" | "where">,
  context: Pick<WorkContext, "config" | "home" | "rootOf">,
): Verdict => {
  const line = lineOf(entry);
  if (kindOf(entry) === "exclusive") {
    return { eligibility: "exclusive", reason: `Always on this Mac: ${nameOf(line)}` };
  }
  const { config, home, rootOf } = context;
  const { unsafe, parts } = readLine(line);
  if (unsafe !== null) {
    return { eligibility: "mac-only", reason: `Couldn't read this command safely (${unsafe})` };
  }
  const work = new Set(workParts(parts));
  if (work.size === 0) return { eligibility: "mac-only", reason: "Nothing in it runs on Linux" };
  const cwds = new Map<string, string | null>([["", entry.cwd]]);
  const vars = new Map<string, string | null>([["HOME", home]]);
  const cwdAt = (scope: ReadonlyArray<number>): string | null => {
    const key = scope.join("/");
    if (!cwds.has(key)) cwds.set(key, cwdAt(scope.slice(0, -1)));
    return cwds.get(key)!;
  };
  let notListed: string | null = null;
  for (const part of parts) {
    const { command } = part;
    const cwd = cwdAt(command.scope);
    if (work.has(part)) {
      const tie = tieOf(part, cwd, vars, rootOf, config);
      if (tie !== null) return { eligibility: "mac-only", reason: tie };
      const text = part.values.slice(part.remoteAt).join(" ");
      if (
        notListed === null &&
        entry.where === undefined &&
        part.remoto === null &&
        !matchesAny(text, config.runnerLinuxCommands)
      ) {
        notListed = `Not on the Can run on Linux list: ${nameOf(text)}`;
      }
    }
    // A substitution runs in its own subshell: its folder and variables end with it.
    if (command.substituted) continue;
    const first = part.values[0];
    if (first === "cd" || first === "pushd" || first === "popd") {
      const args = command.words.slice(1).filter((word) => !/^-[LPe@]+$/.test(word.value));
      const target =
        first === "popd" || command.conditional || cwd === null || args.length > 1
          ? null
          : args[0] === undefined
            ? home
            : literalValue(args[0], vars, cwd);
      cwds.set(
        command.scope.join("/"),
        target === null || target === "-" ? null : resolvePath(cwd ?? "/", target),
      );
    }
    const assignments =
      command.words.length === 0
        ? command.assigns
        : DECLARES.has(first ?? "")
          ? command.words.slice(1).filter((word) => /^[A-Za-z_]\w*=/.test(word.value))
          : [];
    for (const word of assignments) {
      const name = word.value.slice(0, word.value.indexOf("="));
      const value = literalValue(
        { ...word, value: word.value.slice(name.length + 1) },
        vars,
        cwd ?? "/",
      );
      vars.set(name, command.conditional ? null : value);
    }
  }
  return notListed === null
    ? { eligibility: "linux", reason: null }
    : { eligibility: "not-listed", reason: notListed };
};

export interface LinuxHealth extends Sustained {
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
  overLimit: false,
  overLimitSince: null,
  underLimitSince: null,
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

const GIB = 1024 ** 3;

/** Which of Linux's own limits a reading is past, for the waiting reason; null when none or unknown. */
const linuxOverBy = (reading: LinuxReading, machine: RunnerMachineConfig): string | null => {
  const { availableMemoryBytes: free, totalMemoryBytes: total, load1, cpuCount } = reading;
  const floor = machine.runnerLinuxMemoryFloorPercent;
  if (free !== null && total !== null && free < (floor / 100) * total) {
    return `${(Math.max(0, free) / GIB).toFixed(1)} GB free, keeping ${floor}%`;
  }
  if (load1 === null || cpuCount === null) return null;
  const cpu = (load1 / cpuCount) * 100;
  return cpu > machine.runnerLinuxCpuCeilingPercent
    ? `CPU ${Math.round(cpu)}%, limit ${machine.runnerLinuxCpuCeilingPercent}%`
    : null;
};

/**
 * Offline after the configured failures in a row, online again after one success. Each reading
 * also moves Linux over or back under its limits, only once that lasts `windowMs`.
 */
export const nextHealth = (
  previous: LinuxHealth,
  check: HealthCheck,
  machine: RunnerMachineConfig,
  windowMs: number,
  now: number,
): LinuxHealth => {
  if (check.ok) {
    // One missed beat keeps the run of readings; a longer silence starts over from "has room".
    const gapMs = 2 * (machine.runnerHeartbeatSeconds + machine.runnerSshTimeoutSeconds) * 1000;
    const continuous = previous.okAt !== null && now - previous.okAt <= gapMs;
    const over = linuxOverBy(check.reading, machine) !== null;
    return {
      online: true,
      failures: 0,
      checkedAt: now,
      okAt: now,
      ...check.reading,
      ...sustain(continuous ? previous : null, over, now, windowMs),
    };
  }
  const failures = previous.failures + 1;
  return {
    ...previous,
    online: failures >= machine.runnerOfflineAfterFailures ? false : previous.online,
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
  readonly home: string;
  /** The git checkout `remoto` would sync from a folder, or null outside any. */
  readonly rootOf: (cwd: string) => string | null;
}

export interface RoutePlanInput extends PlanInput {
  readonly contextOf: (cwd: string) => WorkContext;
  readonly machine: RunnerMachineConfig;
  readonly health: LinuxHealth;
  /** Some project uses the Runner: Mac rows then say why they stay. */
  readonly runnerOn?: boolean;
}

interface LinuxBusy {
  readonly kind: "slots" | "worktree" | "limits" | "reading";
  readonly why: string;
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
  /** Waiters Linux holds back only because it is over its own limits, with which one. */
  readonly linuxOver: Readonly<Record<string, string>>;
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

/**
 * A drop keeps its policy until it resolves: "Run on this Mac" and an unanswered question are
 * not undone by the next good heartbeat. Waiting (chosen, or an expired question) ends the hold.
 */
const dropHolds = (entry: HeavyQueueEntry, config: RunnerProjectConfig, now: number) =>
  entry.dropped === true &&
  entry.route === undefined &&
  (config.runnerDropped === "mac" ||
    (config.runnerDropped === "ask" &&
      !(askExpired(entry, now) && config.runnerDeadlineAction === "wait")));

/** Where the entry's own settings send it before Linux health is considered. */
export const intentOf = (
  entry: HeavyQueueEntry,
  context: WorkContext,
): { readonly intent: "mac" | "linux" | "automatic"; readonly reason: string } => {
  const mac = (reason: string) => ({ intent: "mac" as const, reason });
  if (!context.config.runnerEnabled) {
    // Only a commit whose hook runs is queued, so the queue can say why it waits.
    return mac(commitOnly(lineOf(entry)) === null ? "Runner off for this project" : COMMIT_HOOK);
  }
  const verdict = eligibilityOf(entry, context);
  if (verdict.eligibility === "exclusive" || verdict.eligibility === "mac-only") {
    return mac(verdict.reason!);
  }
  if (entry.route === "mac") return mac((entry as QueuedEntry).routeReason ?? "Moved to this Mac");
  if (entry.route === "linux") return { intent: "linux", reason: "" };
  // `--runner` (an agent's own `remoto` call) speaks for the job; otherwise only listed work leaves.
  const where = entry.where ?? (verdict.reason === null ? context.config.runnerWhere : "mac");
  if (where !== "mac") return { intent: where, reason: "" };
  return mac(
    verdict.reason ?? (entry.where === "mac" ? "Asked for this Mac" : "Runner set to this Mac"),
  );
};

/**
 * Decides every waiter for both runners. Hybrid places each in queue order: the Mac while it has
 * room, else Linux while it has room, else the smaller backlog per slot (the Mac on a tie). Room is
 * judged on sustained readings, so a spike never moves work; Hybrid never asks and stays on the Mac
 * while Linux is offline or unknown.
 */
export const planRoutes = (input: RoutePlanInput): RoutePlan => {
  const { entries, now, health, machine, sample } = input;
  const queueOn = input.enabled;
  const paused = queueOn && input.paused;
  const running = entries.filter((entry) => entry.startedAt !== null);
  const waiting = entries.filter((entry) => entry.startedAt === null);
  const linuxRunning = running.filter((entry) => entry.runner === "linux");
  const macRunning = running.filter((entry) => entry.runner !== "linux");
  const busyWorktrees = new Set(linuxRunning.map((entry) => input.contextOf(entry.cwd).worktree));
  let linuxFree = machine.runnerLinuxSlots - linuxRunning.length;
  let linuxCount = linuxRunning.length;
  let macCount = macRunning.length;
  let lastLinuxStart = Math.max(
    -Infinity,
    ...linuxRunning.map((entry) => Date.parse(entry.startedAt!)),
  );
  const fresh = sample !== null && now - sample.at <= SAMPLE_FRESH_MS;
  const macOver = fresh && sample.overLimit === true;
  // `plan` starts nothing beside a job that runs alone.
  const macExclusive = queueOn && macRunning.some((entry) => kindOf(entry) === "exclusive");
  const reading = health.load1 !== null || health.availableMemoryBytes !== null;

  const admits: Record<string, Admit> = {};
  const routes: Record<string, HeavyRunner> = {};
  const reasons: Record<string, string> = {};
  const asks: Record<string, HeavyRunnerAskReason> = {};
  const cancels: Record<string, string> = {};
  const linuxOver: Record<string, string> = {};
  const macWaiters: HeavyQueueEntry[] = [];
  /** Why each job runs on this Mac, shown with what it waits for there. */
  const macWhy: Record<string, string> = {};

  /** Mac rows say why only once a Runner is on, except a commit, which says why it waits at all. */
  const shows = (reason: string) => input.runnerOn === true || reason === COMMIT_HOOK;
  const toMac = (entry: HeavyQueueEntry, reason: string) => {
    if (shows(reason)) macWhy[entry.id] = reason;
    routes[entry.id] = "mac";
    macCount += 1;
    if (queueOn) macWaiters.push(entry);
    else admits[entry.id] = { runner: "mac", ungated: true };
  };
  const toLinux = (entry: HeavyQueueEntry, busy: LinuxBusy | string) => {
    routes[entry.id] = "linux";
    linuxCount += 1;
    if (typeof busy === "string") reasons[entry.id] = busy;
    else {
      reasons[entry.id] = `waiting for Linux: ${busy.why}`;
      if (busy.kind === "limits") linuxOver[entry.id] = busy.why;
    }
  };
  /**
   * The Mac takes `entry` now: slots and the job's own fit (with the queue on) and its sustained
   * limits. The fit counts only where `plan` would judge it: beside other work, under the instant
   * limits, which only the sustained ones may turn into a move.
   */
  const macRoom = (entry: HeavyQueueEntry) =>
    !macOver &&
    !macExclusive &&
    (!queueOn ||
      (macCount < Math.max(1, input.maxRunning) &&
        (macCount === 0 ||
          !fresh ||
          machineHold(sample, input) !== null ||
          jobVerdict(input, sample, entry).hold === null)));
  /** Why Linux cannot take a job of `worktree` now, or null when it can. */
  const linuxBusy = (worktree: string): LinuxBusy | null => {
    if (linuxFree <= 0) {
      return { kind: "slots", why: `all ${machine.runnerLinuxSlots} Linux slots are busy` };
    }
    if (busyWorktrees.has(worktree)) {
      return { kind: "worktree", why: "this worktree is already running on Linux" };
    }
    if (health.overLimit) {
      return {
        kind: "limits",
        why: linuxOverBy(health, machine) ?? "easing back under its limits",
      };
    }
    // A reading from before the last start does not show its load yet.
    if (reading && (health.okAt ?? 0) <= lastLinuxStart) {
      return { kind: "reading", why: "a fresh reading since the last job started there" };
    }
    return null;
  };
  /** Start now skips Linux's wait, but not a run of the same worktree that `remoto` would serialize. */
  const startsOnLinux = (entry: HeavyQueueEntry, busy: LinuxBusy) =>
    entry.forced === true && busy.kind !== "worktree";
  const toLinuxNow = (entry: HeavyQueueEntry, worktree: string) => {
    routes[entry.id] = "linux";
    linuxCount += 1;
    linuxFree -= 1;
    busyWorktrees.add(worktree);
    lastLinuxStart = now;
    admits[entry.id] = { runner: "linux", ungated: !queueOn };
  };

  for (const entry of macRunning) {
    const { intent, reason } = intentOf(entry, input.contextOf(entry.cwd));
    if (intent === "mac" && shows(reason)) macWhy[entry.id] = reason;
  }
  for (const entry of waiting) {
    const context = input.contextOf(entry.cwd);
    const { config, worktree } = context;
    if (entry.unconfirmed === true) {
      routes[entry.id] = entry.route ?? "linux";
      reasons[entry.id] = "Linux dropped it mid-run: confirming it stopped there before rerunning";
      continue;
    }
    const { intent, reason: why } = intentOf(entry, context);
    if (intent === "mac") {
      toMac(entry, why);
      continue;
    }
    const up = linuxUpFor(health, entry) && !dropHolds(entry, config, now);
    if (intent === "automatic") {
      if (paused || !up || macRoom(entry)) {
        toMac(
          entry,
          paused
            ? "Hybrid: queue paused"
            : !up
              ? "Hybrid: Linux is unavailable"
              : "Hybrid: this Mac has room",
        );
        continue;
      }
      const busy = linuxBusy(worktree);
      if (busy === null) toLinuxNow(entry, worktree);
      // Both are full: the smaller backlog per slot, the Mac on a tie. With the queue off the Mac
      // never waits, so it starts here.
      else if (
        queueOn &&
        linuxCount / machine.runnerLinuxSlots < macCount / Math.max(1, input.maxRunning)
      ) {
        if (startsOnLinux(entry, busy)) toLinuxNow(entry, worktree);
        else toLinux(entry, busy);
      } else toMac(entry, "Hybrid: this Mac's backlog is shorter");
      continue;
    }
    // Bound for Linux.
    if (paused && !(up && entry.forced === true)) {
      toLinux(entry, "paused");
      continue;
    }
    if (up) {
      const busy = linuxBusy(worktree);
      if (busy !== null && !startsOnLinux(entry, busy)) toLinux(entry, busy);
      else toLinuxNow(entry, worktree);
      continue;
    }
    if (health.online === null && entry.linuxFailedAt === undefined) {
      toLinux(entry, "checking whether Linux is up");
      continue;
    }
    // The user (or an expired question) already chose to wait.
    if (entry.route === "linux") {
      toLinux(entry, "waiting for Linux to come back");
      continue;
    }
    const reason: HeavyRunnerAskReason = entry.dropped === true ? "dropped" : "unavailable";
    const policy = reason === "dropped" ? config.runnerDropped : config.runnerUnavailable;
    const what = reason === "dropped" ? "Linux dropped it mid-run" : "Linux is unavailable";
    if (policy === "mac") {
      toMac(entry, `${what}: running here`);
      continue;
    }
    if (policy === "wait") {
      toLinux(entry, `${what}: waiting for it`);
      continue;
    }
    if (entry.ask === undefined) {
      asks[entry.id] = reason;
      toLinux(entry, `${what}: asking you`);
      continue;
    }
    if (!askExpired(entry, now)) {
      toLinux(entry, `${what}: waiting for your answer`);
      continue;
    }
    if (config.runnerDeadlineAction === "mac")
      toMac(entry, `${what} and nobody answered: running here`);
    else if (config.runnerDeadlineAction === "wait") {
      toLinux(entry, `${what}: no answer, waiting for it`);
    } else {
      routes[entry.id] = "linux";
      cancels[entry.id] = `${what} and nobody answered in time: canceled`;
    }
  }

  if (!queueOn) {
    return {
      admits,
      routes,
      reasons: { ...macWhy, ...reasons },
      linuxOver,
      asks,
      cancels,
      room: true,
      holding: false,
      mac: null,
    };
  }
  const mac = plan({ ...input, entries: [...macRunning, ...macWaiters] });
  if (mac.admit !== null) admits[mac.admit] = { runner: "mac", ungated: false };
  return {
    admits,
    routes,
    reasons: {
      ...macWhy,
      ...Object.fromEntries(
        Object.entries(mac.reasons).map(([id, why]) => [
          id,
          macWhy[id] === undefined ? why : `${macWhy[id]} · ${why}`,
        ]),
      ),
      ...reasons,
    },
    linuxOver,
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

/**
 * `remoto`'s folder name on Linux for a checkout: its basename with every character outside
 * `[A-Za-z0-9._-]` turned into `_` (macOS `tr -c` in a UTF-8 locale), a dash, and the first 8 hex
 * digits of the SHA-1 of its real path (`shasum`), which `git rev-parse --show-toplevel` gives it.
 */
export const runnerCopyId = (realPath: string, sha1: (text: string) => string) =>
  `${realPath.slice(realPath.lastIndexOf("/") + 1).replace(/[^A-Za-z0-9._-]/gu, "_")}-${sha1(realPath).slice(0, 8)}`;

const RUNNER_COPY_ID = /^[A-Za-z0-9._-]+-[0-9a-f]{8}$/;

/**
 * Deletes `runs/<id>` and the lock and pgid files `remoto-rodar` keeps beside it. Prints `busy` when
 * a run still holds it, `removed` otherwise.
 */
export const removeCopyScript = (id: string) => {
  if (!RUNNER_COPY_ID.test(id) || id.startsWith(".")) throw new Error(`Unsafe run id: ${id}`);
  const folder = `"$HOME/runs/${id}"`;
  return [
    `p=$(cat ${folder}.pgid 2>/dev/null)`,
    `if [ -n "$p" ] && kill -0 "-$p" 2>/dev/null; then echo busy; exit 0; fi`,
    `rm -rf -- ${folder} ${folder}.lock ${folder}.pgid && echo removed`,
  ].join("\n");
};

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
