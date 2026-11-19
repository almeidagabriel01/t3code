// @effect-diagnostics nodeBuiltinImport:off - Records are written by the plain-Node queue file.
/**
 * Heavy job notices. The queue file logs each transition where it is decided (a job ending, a
 * requeue, an admission, a deadline cancel), because the state alone loses why it happened. This
 * module turns those records, plus Linux health and long waits, into grouped toasts.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { listensHere, localPortsIn } from "./localPorts.ts";
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

/** What a Linux job's calls copied back to this Mac, and what they left there, summed. */
export interface SyncBack {
  readonly copied: number;
  /** Changed on this Mac during the run: this Mac's version stays. */
  readonly skipped: number;
  /** Deleted on Linux: deletions are not applied here. */
  readonly deleted: number;
  /** The largest result over the size cap, in MB: that call copied nothing. */
  readonly overCapMB?: number;
  /** Calls whose copy failed. */
  readonly failed: number;
}

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** What stayed on Linux, for a card; null when everything came back. */
const syncBackText = (sync: SyncBack) => {
  const parts = [
    ...(sync.overCapMB === undefined ? [] : [`${sync.overCapMB} MB of results, over the size cap`]),
    ...(sync.failed === 0
      ? []
      : [sync.failed === 1 ? "the copy failed" : `${sync.failed} copies failed`]),
    ...(sync.skipped === 0
      ? []
      : [`${counted(sync.skipped, "file", "files")} changed on this Mac during the run`]),
    ...(sync.deleted === 0 ? [] : [`${counted(sync.deleted, "deletion", "deletions")} there`]),
  ];
  return parts.length === 0 ? null : `Not copied back from Linux: ${parts.join("; ")}`;
};

export type HeavyEvent =
  /** Exited with a failure; `phase` is where a Linux job was. */
  | {
      readonly kind: "ended";
      readonly code: number;
      /** Why it could not start, when the CLI can tell (a missing script). */
      readonly error?: string;
      readonly phase?: HeavyRunnerPhase;
      /** What in its worktree kept Linux from installing it, and the fix. */
      readonly worktree?: string;
      readonly syncBack?: SyncBack;
    }
  /** Succeeded on Linux, and part of its results stayed there. */
  | { readonly kind: "sync-back"; readonly syncBack: SyncBack }
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
  /** It ran and its exit code and output show Linux lacked something (`environmentFaultOf`). */
  | { readonly kind: "environment"; readonly fault: EnvironmentFault }
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

/** A shell's own prefix on an error: `sh: 1: `, `bash: line 1: `, `/bin/sh: `, `sh: 1: exec: `. */
const SHELL = String.raw`(?:\S*/)?(?:ba|da|z|k)?sh(?:: line \d+|: \d+)?: (?:exec: )?`;
/**
 * The shell or `env` saying it found no program to run: `vp: command not found`, `sh: 1: vp: not
 * found`, `zsh: command not found: vp`, `bash: ./x.sh: No such file or directory`, `env: 'tsx': …`.
 */
const MISSING_TOOL = new RegExp(
  [
    String.raw`^(?:${SHELL})?([^\s:]+): command not found$`,
    String.raw`^${SHELL}([^\s:]+): (?:not found|No such file or directory)$`,
    String.raw`^zsh: command not found: (\S+)$`,
    String.raw`^(?:\S*/)?env: ['‘]?([^\s:'’]+)['’]?: No such file or directory$`,
  ].join("|"),
);
/** The shell saying it found a program it can't run: `bash: ./run.sh: Permission denied`. */
const NOT_EXECUTABLE = new RegExp(
  String.raw`^(?:${SHELL}|(?:\S*/)?env: )['‘]?([^\s:'’]+)['’]?: (?:Permission denied|cannot execute.*)$`,
);

/** What Linux lacked for a call that ran there; `install` is the copy's unfinished install. */
export type EnvironmentFaultKind =
  | "missing-program"
  | "not-executable"
  | "no-git"
  | "package-command"
  | "no-browser"
  | "local-service"
  | "python-module"
  | "install";

export interface EnvironmentFault {
  readonly kind: EnvironmentFaultKind;
  /** What it lacked: a program, a module, a service's address. */
  readonly subject: string;
  /** The output line that shows it, for the card. */
  readonly line: string;
}

/** How much of a call's output is kept to classify its failure. */
export const TAIL_CHARS = 64 * 1024;
export const appendTail = (tail: string, text: string) => {
  const joined = tail + text;
  return joined.length > TAIL_CHARS ? joined.slice(-TAIL_CHARS) : joined;
};

/** How far from the end a `recent` row's line may be: earlier, a test that passed may have logged it. */
const RECENT_LINES = 20;

/**
 * Exit code and output line that mean Linux lacked something the Mac has. Every row needs its
 * line: an exit code alone is any program's own (a wrapper may exit 127 on purpose). A row without
 * a code takes any failure. A `recent` row's line counts only among the last `RECENT_LINES`.
 */
const ENVIRONMENT_FAULTS: ReadonlyArray<{
  readonly kind: Exclude<EnvironmentFaultKind, "install">;
  readonly code?: number;
  readonly pattern: RegExp;
  readonly recent?: true;
}> = [
  { kind: "missing-program", code: 127, pattern: MISSING_TOOL },
  { kind: "not-executable", code: 126, pattern: NOT_EXECUTABLE },
  { kind: "no-git", code: 128, pattern: /^fatal: not a git repository/ },
  {
    kind: "package-command",
    pattern: /(?:ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL\s+|^)Command "([^"]+)" not found/,
    recent: true,
  },
  { kind: "no-browser", pattern: /Executable doesn't exist at \S*ms-playwright\/([^/\s]+)/ },
  {
    kind: "local-service",
    pattern: /ECONNREFUSED ((?:localhost|127\.0\.0\.1|::1|\[::1\]):\d+)/,
    recent: true,
  },
  { kind: "python-module", pattern: /No module named '?([\w.]+)'?/, recent: true },
];

/**
 * The environment fault a call that ran on Linux shows, from its exit code and output tail, or
 * null when it failed in its own code. A Python module that is a file or folder in `folders` is
 * the project's own, missing anywhere. A refused local port is Linux's only while something on
 * this Mac listens on it (`listens`): else it is a server the run itself was to start.
 */
export const environmentFaultOf = (
  code: number,
  tail: string,
  context: {
    readonly program: string;
    readonly folders: ReadonlyArray<string>;
    readonly exists?: (path: string) => boolean;
    readonly listens?: (port: number) => boolean;
  },
): EnvironmentFault | null => {
  if (code === 0) return null;
  const exists = context.exists ?? NodeFS.existsSync;
  const listens = context.listens ?? listensHere;
  const lines = meaningfulLines(tail.slice(-TAIL_CHARS))
    .filter((line) => !line.startsWith("[t3 heavy]"))
    .toReversed();
  for (const row of ENVIRONMENT_FAULTS) {
    if (row.code !== undefined && row.code !== code) continue;
    let match: RegExpExecArray | null = null;
    let line = "";
    for (const each of row.recent ? lines.slice(0, RECENT_LINES) : lines) {
      match = row.pattern.exec(each);
      if (match !== null) {
        line = each;
        break;
      }
    }
    if (match === null) continue;
    const subject = match.slice(1).find((group) => group !== undefined) ?? context.program;
    if (row.kind === "local-service" && !localPortsIn(subject).some(listens)) continue;
    if (row.kind === "python-module") {
      const top = subject.split(".")[0]!;
      const own = context.folders.some(
        (folder) =>
          exists(NodePath.join(folder, top)) || exists(NodePath.join(folder, `${top}.py`)),
      );
      if (own) continue;
    }
    return {
      kind: row.kind,
      subject: row.kind === "python-module" ? subject.split(".")[0]! : subject,
      line,
    };
  }
  return null;
};

/** The problem detector's reason and stable cause detail for each environment fault. */
const environmentCause = ({ kind, subject }: EnvironmentFault): [FaultReason, string] => {
  switch (kind) {
    case "missing-program":
    case "not-executable":
    case "package-command":
      return ["command-not-found", subject];
    case "no-browser":
      return ["command-not-found", "playwright-browser"];
    case "python-module":
      return ["command-not-found", `python-${subject}`];
    case "no-git":
      return ["linux-sync", "no-git"];
    case "local-service":
      return ["network", "localhost"];
    case "install":
      return ["linux-install", subject];
  }
};

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
  if (seen.kind === "environment") {
    const [reason, detail] = environmentCause(seen.fault);
    return { ...fault(reason, detail, ""), error: seen.fault.line };
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
  entry: Pick<HeavyQueueEntry, "id" | "label" | "name" | "threadId" | "runner"> & {
    readonly line?: string;
  },
  fault: Fault,
  now: number,
): HeavyEventRecord => recordOf(entry, { kind: "t3-fault", ...fault }, now);

export type HeavyEventRecord = HeavyEvent & {
  readonly id: string;
  readonly at: number;
  readonly job: {
    readonly id: string;
    readonly name: string;
    /** The full command line when `name` is not it; absent in records written before it was kept. */
    readonly label?: string;
    readonly threadId: string | null;
    readonly runner: HeavyRunner;
  };
};

export const EVENT_LOG_SIZE = 50;

/** Exit codes that mean someone stopped it: removed (125) or a signal. */
const STOPPED_CODES = new Set([0, 125, 129, 130, 143]);

/**
 * Why a job exited 126/127 when a file it runs is the cause: those codes alone don't say a script
 * was missing. `scripts` are the files its line runs (`sh -c './fmt.sh'`); a bare program name is
 * a PATH lookup, and an existing script that exits 127 itself is left to its own output.
 */
export const startFailureOf = (
  program: string,
  scripts: ReadonlyArray<string>,
  cwd: string,
  code: number,
  exists: (path: string) => boolean = NodeFS.existsSync,
) => {
  if (code !== 126 && code !== 127) return undefined;
  const own = program.includes("/") ? NodePath.resolve(cwd, program) : null;
  const files = [
    ...(own === null ? [] : [own]),
    ...scripts.map((each) => NodePath.resolve(cwd, each)),
  ];
  const missing = files.find((file) => !exists(file));
  if (missing === undefined)
    return code === 126 && own !== null ? `not executable: ${own}` : undefined;
  const bin = /\/node_modules\/\.bin\/([^/]+)$/.exec(missing)?.[1];
  return (bin === undefined ? null : binHint(bin, cwd, exists)) ?? `script not found: ${missing}`;
};

/**
 * For a project bin this Mac lacks: where the checkout has it after all, or that its dependencies
 * aren't installed (a `package.json` with no `node_modules` from `cwd` up). Null when neither.
 */
const binHint = (name: string, cwd: string, exists: (path: string) => boolean) => {
  let modules = false;
  let project = false;
  for (let dir = cwd; ; dir = NodePath.dirname(dir)) {
    const bin = NodePath.join(dir, "node_modules", ".bin", name);
    if (exists(bin)) return `${name} not found from ${cwd}; it is at ${bin}`;
    modules ||= exists(NodePath.join(dir, "node_modules"));
    project ||= exists(NodePath.join(dir, "package.json"));
    if (dir === NodePath.dirname(dir)) break;
  }
  return project && !modules
    ? `${name} not found in ${cwd}: its dependencies aren't installed; run \`vp i\``
    : null;
};

/**
 * Why this Mac can't find `program` where Linux's pre-flight looks (the project's bins from `cwd`
 * up to `root`, then PATH, builtins included), or undefined when it can. Missing here too, the
 * command is wrong, not Linux.
 */
export const notFoundHere = (
  program: string,
  cwd: string,
  root: string,
  path = process.env.PATH ?? "",
) => {
  const bins: string[] = [];
  for (let dir = cwd; ; dir = NodePath.dirname(dir)) {
    bins.push(NodePath.join(dir, "node_modules", ".bin"));
    if (dir === root || dir === NodePath.dirname(dir)) break;
  }
  const found = NodeChildProcess.spawnSync("bash", ["-c", 'command -v -- "$1"', "t3", program], {
    cwd,
    env: { ...process.env, PATH: [...bins, path].join(":") },
    stdio: "ignore",
  });
  // Only bash's own "not found" counts: a shell that failed to start judges nothing.
  if (found.status !== 1) return undefined;
  return missingProgramOf(program, cwd) ?? `command not found on this Mac either: ${program}`;
};

/** What a program this Mac can't start lacks: its file, or the dependencies its project bin needs. */
export const missingProgramOf = (program: string, cwd: string) =>
  startFailureOf(program, [], cwd, 127) ?? binHint(program, cwd, NodeFS.existsSync) ?? undefined;

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** Decoration only: rules and counters such as vitest's `⎯⎯⎯[50/62]⎯`. */
const RULE = /^[\s\-=_*~·.⎯─━═│|[\]\d/]*$/u;

/** The lines of command output that say something: no colour codes, blanks, rules or counters. */
export const meaningfulLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(ANSI, "").trim())
    .filter((line) => !RULE.test(line));

const FAILURE = /\bFAIL\b|\bERR_[A-Z0-9_]+|\bERR!|[A-Za-z]*Error\b|\berror TS\d+/;
const WARNING = /^(?:(?:npm|pnpm|yarn|node)\s+)?warn(?:ing)?\b|^\(node:\d+\)\s|^[\w.-]*Warning:/i;
/** A warning that still reports a failure, such as cargo's `warning: build failed`. */
const FAILED =
  /\b(?:fail(?:s|ed|ure)?|fatal|errors?|abort(?:ing|ed)?|refus(?:e|ed|ing)|cannot|can't|unable|denied|exit(?:ing)? with code)\b/i;

/** A line that is only a warning: it never names what failed, whatever the exit code says. */
const warningOnly = (line: string) =>
  WARNING.test(line) && !FAILURE.test(line) && !FAILED.test(line);

/**
 * The lines of a chunk of output worth quoting on a card: the first one that names a failure, and
 * the last meaningful one that is not only a warning, both without ANSI codes, rules, or T3's own
 * notes.
 */
export const errorLineOf = (text: string) => {
  const lines = meaningfulLines(text).filter((line) => !line.startsWith("[t3 heavy]"));
  return {
    failure: lines.find((line) => FAILURE.test(line)) ?? null,
    last: lines.findLast((line) => !warningOnly(line)) ?? null,
  };
};

const LINE_CHARS = 1000;

/** The line a job ran, cut where a card or the queue file would carry only noise (a heredoc). */
export const lineOf = (entry: Pick<HeavyQueueEntry, "label"> & { readonly line?: string }) => {
  const line = entry.line ?? entry.label;
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line;
};

const recordOf = (
  entry: Pick<HeavyQueueEntry, "id" | "label" | "name" | "threadId" | "runner"> & {
    readonly line?: string;
  },
  event: HeavyEvent,
  now: number,
): HeavyEventRecord => {
  // The full line, kept apart from `name`: `label` drops the script's folder and is cut short.
  const line = entry.line === undefined && entry.name === undefined ? undefined : lineOf(entry);
  return {
    ...event,
    id: NodeCrypto.randomUUID(),
    at: now,
    job: {
      id: entry.id,
      name: entry.name ?? entry.label,
      ...(line === undefined ? {} : { label: line }),
      threadId: entry.threadId,
      runner: entry.runner ?? "mac",
    },
  };
};

/** A job's own process ending; null for success, a stop, or an entry already gone. */
export const endedRecord = (
  entry:
    | (HeavyQueueEntry & {
        readonly worktree?: string;
        readonly line?: string;
        readonly syncBack?: SyncBack;
      })
    | undefined,
  code: number,
  now: number,
  error?: string,
): HeavyEventRecord | null => {
  if (entry === undefined) return null;
  const { syncBack } = entry;
  if (STOPPED_CODES.has(code)) {
    return code === 0 && syncBack !== undefined && syncBackText(syncBack) !== null
      ? recordOf(entry, { kind: "sync-back", syncBack }, now)
      : null;
  }
  return recordOf(
    entry,
    {
      kind: "ended",
      code,
      ...(error === undefined ? {} : { error }),
      ...(entry.runner === "linux" && entry.phase !== undefined ? { phase: entry.phase } : {}),
      ...(entry.runner === "linux" && entry.worktree !== undefined
        ? { worktree: entry.worktree }
        : {}),
      ...(syncBack === undefined ? {} : { syncBack }),
    },
    now,
  );
};

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
          description: record.error ?? `Command not found or not executable (exit ${record.code})`,
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
      const left = record.syncBack === undefined ? null : syncBackText(record.syncBack);
      return notice({
        group: `failed:${job.runner}`,
        category: "problem",
        tone: "error",
        machine: job.runner,
        one: `${name} failed on ${on}`,
        many: (n) => `${jobs(n)} failed on ${on}`,
        description: `Exit code ${record.code}${left === null ? "" : `. ${left}`}`,
      });
    }
    case "sync-back":
      return notice({
        group: "sync-back",
        category: "unexpected",
        tone: "warning",
        machine: "linux",
        one: `Not all of ${name}'s results came back from Linux`,
        many: (n) => `Not all results of ${jobs(n)} came back from Linux`,
        description: syncBackText(record.syncBack) ?? "",
      });
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
