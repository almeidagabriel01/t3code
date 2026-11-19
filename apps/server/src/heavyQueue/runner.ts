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
  type RunnerWhere,
} from "@t3tools/contracts";

import {
  jobVerdict,
  kindOf,
  machineHold,
  plan,
  SAMPLE_FRESH_MS,
  SWAP_IN_LIMIT,
  sustain,
  type Plan,
  type Sample,
  type PlanInput,
  type Sustained,
} from "./admission.ts";
import {
  entryOf,
  EXECUTORS,
  FOLDER_FLAGS,
  lineParts,
  nameOf,
  PACKAGE_SCRIPT,
  pmBinAt,
  readLine,
  RUNNERS as PACKAGE_MANAGERS,
  shellQuote,
  TYPE_CHECKERS,
  workParts,
  type Part,
  type ReadScript,
} from "./heavyHook.ts";
import type { SyncBack } from "./heavyNotices.ts";
import { localPortsIn } from "./localPorts.ts";
import type { Word } from "./shellLine.ts";

export const DEFAULT_PROJECT_CONFIG: RunnerProjectConfig = {
  runnerEnabled: RUNNER_DEFAULTS.runnerEnabled,
  runnerWhere: RUNNER_DEFAULTS.runnerWhere,
  runnerUnavailable: RUNNER_DEFAULTS.runnerUnavailable,
  runnerLinuxFull: RUNNER_DEFAULTS.runnerLinuxFull,
  runnerAskMinutes: RUNNER_DEFAULTS.runnerAskMinutes,
  runnerDeadlineAction: RUNNER_DEFAULTS.runnerDeadlineAction,
  runnerDropped: RUNNER_DEFAULTS.runnerDropped,
  runnerMacOnly: RUNNER_DEFAULTS.runnerMacOnly,
  runnerMacFirstAfter: RUNNER_DEFAULTS.runnerMacFirstAfter,
  runnerBringBack: RUNNER_DEFAULTS.runnerBringBack,
  runnerRouteMemoryDays: RUNNER_DEFAULTS.runnerRouteMemoryDays,
  runnerRouteLearnAfter: RUNNER_DEFAULTS.runnerRouteLearnAfter,
  runnerBringBackExclude: RUNNER_DEFAULTS.runnerBringBackExclude,
  runnerBringBackMaxMB: RUNNER_DEFAULTS.runnerBringBackMaxMB,
  runnerMacTools: RUNNER_DEFAULTS.runnerMacTools,
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
  runnerLinuxEvictionsBeforeAlone: RUNNER_DEFAULTS.runnerLinuxEvictionsBeforeAlone,
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

/** A list entry naming a kind of work stands for its tools, so a saved list keeps up with them. */
// ponytail: a formatter's check flag right after its script; `fmt -- --check` reads as unlisted.
const KIND_TOOLS: Readonly<Record<string, ReadonlyArray<string>>> = {
  typecheck: TYPE_CHECKERS,
  tsc: TYPE_CHECKERS,
  // A formatter that only checks writes nothing, so it is a check like any other.
  check: ["fmt --check", "format --check"],
};

export const matchesAny = (text: string, patterns: ReadonlyArray<string>) =>
  patterns
    .flatMap((pattern) => [pattern, ...(entryOf(KIND_TOOLS, pattern.trim().toLowerCase()) ?? [])])
    .some((pattern) => pattern.trim() !== "" && patternRegex(pattern).test(text));

export type Eligibility = "linux" | "exclusive" | "mac-only";

/**
 * Why work stays on this Mac, from a closed list: not understanding a command is never one.
 * `learned` is filled by route memory.
 */
export interface MacReason {
  readonly code:
    | "mac-tool"
    | "native-build"
    | "mac-env"
    | "mac-state"
    | "mac-repo"
    | "pinned"
    | "serves-port"
    | "watches"
    | "edits-in-place"
    | "mac-docker"
    | "mac-port"
    | "learned";
  /** The program, pattern or path that keeps it here. */
  readonly subject: string;
}

export interface Verdict {
  readonly eligibility: Eligibility;
  /** For people, on the Resource Manager row; null when Linux can take it. */
  readonly reason: string | null;
  readonly mac?: MacReason;
}

const MAC_REASON_TEXT: Readonly<Record<MacReason["code"], string>> = {
  "mac-tool": "Mac-only tool",
  "native-build": "Builds native code for this Mac",
  "mac-env": "Uses a file only this Mac has",
  "mac-state": "Changes this Mac's checkout",
  "mac-repo": "Uses this Mac's git repository",
  pinned: "Pinned to this Mac",
  "serves-port": "Serves a port used here",
  watches: "Watches this Mac's files",
  "edits-in-place": "Edits this Mac's files in place",
  "mac-docker": "Uses this Mac's Docker",
  "mac-port": "Talks to a port open here",
  learned: "Linux couldn't run this before",
};

export const macReasonText = ({ code, subject }: MacReason) =>
  `${MAC_REASON_TEXT[code]}: ${subject}`;

const macOnly = (mac: MacReason): Verdict => ({
  eligibility: "mac-only",
  reason: macReasonText(mac),
  mac,
});

/**
 * Fields only the queue file keeps: a job's full command line (the label is cut short for the
 * row) and why a Linux attempt sent it back to this Mac.
 */
export type QueuedEntry = HeavyQueueEntry & {
  readonly line?: string;
  readonly routeReason?: string;
  /** The scripts the line runs, read when it was queued, by their path word; null: unreadable. */
  readonly scripts?: Readonly<Record<string, string | null>>;
  /** Its Linux runs that lost the link in a row; it keeps going back there until `linkAttempts`. */
  readonly linkFailures?: number;
  /** Linux ran it and its environment failed (not the link): "If a Linux run fails" holds it. */
  readonly failure?: string;
  /** Its worktree broke the install on Linux (a stale lockfile): the fix, for its end notice. */
  readonly worktree?: string;
  /** Its question and answer while a Linux attempt runs: back if the attempt never got there. */
  readonly held?: Pick<HeavyQueueEntry, "ask" | "route">;
  /** Its running Linux attempt must end: Linux ran short of memory, or restarted under it. */
  readonly stop?: "memory" | "reboot";
  /** Its Linux runs stopped for memory so far, and when the last one was. */
  readonly evictions?: number;
  readonly evictedAt?: number;
  readonly syncBack?: SyncBack;
  /** A Mac job's own call queued for Linux: when Linux can't take it, it runs under that job. */
  readonly call?: boolean;
  /** Asked with `--runner linux`, not by an agent's `remoto`: see `askedLinux`. */
  readonly linuxOnly?: boolean;
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
 * The path an argument names outside the checkout Linux gets a copy of: an absolute or `..` path,
 * alone or as `--flag=<path>`. Null when it names none.
 */
const outsidePath = (arg: string, cwd: string, root: string): string | null => {
  const flagValue = /^-[\w.-]*=(.+)$/.exec(arg)?.[1];
  for (const candidate of [arg, flagValue]) {
    if (candidate === undefined || !/^(\/|\.\.(\/|$))/.test(candidate)) continue;
    const path = resolvePath(cwd, candidate);
    if (!inside(path, root) && !SHARED.test(path)) return path;
  }
  return null;
};

const BOTH_AT_LIMITS = "Both machines are at their limits";
const LINUX_FULL_MAC = "Linux is full: running on this Mac";
export const LINUX_FULL_SHORTER = "Linux is full: shorter queue on this Mac";
export const LINUX_FULL_WAITING = "Linux is full: waiting (this Mac is busier)";

const INSTALLS = /^(install|i|add|remove|rm|uninstall|un|update|up|upgrade|ci|link|unlink|dedupe)$/;
const GIT_WRITES =
  /^(commit|merge|rebase|cherry-pick|am|revert|reset|checkout|switch|stash|tag|pull|fetch)$/;
const DEV_WORD = /^(dev|start|serve|preview|storybook)$/;
/** A finite step a script's name may also name: `serve-static-build` builds and ends. */
const FINITE_STEP = /^(build|test|lint|check|typecheck|e2e|ci|bundle|compile|export|generate)$/;
/**
 * A script or task that never ends: a watch segment anywhere in its name watches; a server word
 * leading it with no finite step after serves.
 */
const scriptCode = (name: string): "watches" | "serves-port" | null => {
  const [head = "", ...rest] = name.split(/[:._-]/);
  if (head === "watch" || rest.includes("watch")) return "watches";
  const serves = DEV_WORD.test(head) && !rest.some((each) => FINITE_STEP.test(each));
  return serves ? "serves-port" : null;
};
const DEV_PROGRAMS: Readonly<Record<string, RegExp>> = {
  vite: /^(dev|serve|preview)?$/,
  next: /^(dev|start)$/,
  expo: /^start$/,
  wrangler: /^dev$/,
  storybook: /^(dev)?$/,
  "start-storybook": /^/,
  "react-native": /^start$/,
  metro: /^(serve|start)?$/,
};
const TASK_RUNNERS = new Set(["turbo", "nx", "lerna"]);
// `-w` means watch only to these; to `pnpm` it is the workspace root, to `jest` its workers.
const SHORT_WATCH = new Set(["vitest", "mocha", "tsc", "tsgo"]);
const WATCH = /^--watch(All|-path(=.*)?)?(=true)?$/;
/** Runners that restart on file changes: watching is what they are for. */
const WATCHERS = new Set(["nodemon", "ts-node-dev", "tsnd"]);
const DOCKERS = new Set(["docker", "podman", "docker-compose", "nerdctl"]);
const COMPOSE_SUBCOMMAND =
  /^(attach|build|commit|config|cp|create|down|events|exec|export|images|kill|logs|ls|pause|port|ps|pull|push|restart|rm|run|scale|start|stats|stop|top|unpause|up|version|wait|watch)$/;
// `-dp 80:80` and `-itP` end a short cluster with a publish flag; `-ePATH=…` does not.
const PUBLISHES = /^(-[dit]*[pP]|--publish(-all)?(=|$)|--service-ports$|--net(work)?=host$)/;

/**
 * A container tool's reason: a fresh build or run needs nothing of this Mac's daemon, unless it
 * publishes a port here; any other subcommand acts on containers or images that daemon has.
 */
const dockerReason = (
  program: string,
  first: string,
  after: ReadonlyArray<string>,
): MacReason | null => {
  const named = { subject: `${program} ${first}` };
  const compose =
    program === "docker-compose"
      ? after
      : first === "compose"
        ? after.slice(after.indexOf("compose") + 1)
        : null;
  const args = compose ?? after;
  // In compose, `-p` before the subcommand names the project.
  const at =
    compose === null
      ? args.indexOf(first)
      : args.findIndex((word) => COMPOSE_SUBCOMMAND.test(word));
  const sub = args[at] ?? "";
  const rest = args.slice(at + 1);
  const publishes = rest.some(
    (word, index) =>
      PUBLISHES.test(word) || (/^--net(work)?$/.test(word) && rest[index + 1] === "host"),
  );
  // An `up` that ends with its containers is a run: it serves nothing here.
  const ends = rest.some((word) => /^--(abort-on-container-exit|exit-code-from)(=|$)/.test(word));
  if ((compose !== null && sub === "up" && !ends) || (sub === "run" && publishes)) {
    return { code: "serves-port", ...named };
  }
  return (compose === null ? /^(build|buildx|run)$/ : /^(build|run|up)$/).test(sub)
    ? null
    : { code: "mac-docker", ...named };
};
// What they build or run is native to the machine they run on: Linux would bring back an ELF.
const NATIVE_TOOLS = new Set([
  "rustc",
  "swiftc",
  "make",
  "gmake",
  "cmake",
  "ninja",
  "meson",
  "clang",
  "clang++",
  "gcc",
  "g++",
  "cc",
  "c++",
  "ld",
  "xcodebuild",
  "codesign",
  "lipo",
]);
const NATIVE_SUBCOMMANDS: Readonly<Record<string, RegExp>> = {
  cargo: /^(build|b|test|t|run|r|bench|check|c|clippy|nextest|rustc|install|doc|d)$/,
  go: /^(build|test|run|install|vet|generate)$/,
  swift: /./,
};

/** The native toolchain call a program and its words make, by name, or null. */
const nativeBuild = (program: string, words: ReadonlyArray<string>) => {
  if (NATIVE_TOOLS.has(program)) return program;
  // `cargo +nightly build`: a toolchain pick comes before the subcommand.
  const sub = words.find((word) => !word.startsWith("+")) ?? "";
  return entryOf(NATIVE_SUBCOMMANDS, program)?.test(sub) === true ? `${program} ${sub}` : null;
};

/**
 * Flags that take the next word as their value, so it is never the subcommand: a package
 * manager's workspace and folder (`pnpm -F web dev`), a server's address (`vite --port 5174`),
 * a config file, a git setting (`git -c k=v commit`).
 */
// ponytail: these flags only; a program's own value flag before its subcommand needs a row here.
const VALUE_FLAGS = new Set([
  "-F",
  "--filter",
  "--filter-prod",
  "-C",
  "--dir",
  "--prefix",
  "--cwd",
  "--port",
  "-p",
  "--host",
  "--hostname",
  "-H",
  "--mode",
  "-m",
  "--config",
  "-c",
]);

/**
 * A program's subcommand words, past its flags and their values and a Yarn `workspace <name>`
 * (`yarn workspace web dev` → `dev`).
 */
const subcommandWords = (program: string, after: ReadonlyArray<string>) => {
  // npm's `-w <name>` is a workspace; pnpm's `-w` is the workspace root and takes no value.
  const takesValue = (flag: string) =>
    VALUE_FLAGS.has(flag) || (program === "npm" && (flag === "-w" || flag === "--workspace"));
  const words = after.filter(
    (value, at) => !value.startsWith("-") && !takesValue(after[at - 1] ?? ""),
  );
  return program === "yarn" && words[0] === "workspace" ? words.slice(2) : words;
};

/**
 * What a part's program does to this Mac, whatever the patterns say: a Mac-only tool, a native
 * build, a change to this checkout (a git write; an install, whose `node_modules` never comes
 * back), or a server used from here. Judged on the program `npx` or `pnpm exec` runs. In a
 * script's body, an install or a container command is the copy's own: Linux needs the tool.
 */
const programReason = (
  part: Part,
  macTools: ReadonlyArray<string>,
  inScript: boolean,
): MacReason | null => {
  let { program } = part;
  let after = part.values.slice(part.programAt + 1);
  let words = subcommandWords(program, after);
  const binAt = pmBinAt(program, words);
  const execAt = EXECUTORS.has(program) ? -1 : binAt === 1 ? 0 : null;
  // `pnpm tsc --watch` is `pnpm exec tsc --watch` when no script is named tsc: judge the bin first.
  if (binAt === 0) {
    const at = part.programAt + 1;
    const values = [...part.values.slice(0, at), "exec", ...part.values.slice(at)];
    const bin = programReason({ ...part, values }, macTools, inScript);
    if (bin !== null) return bin;
  }
  if (execAt !== null) {
    const raw = words[execAt + 1] ?? "";
    program = programName(raw);
    after = after.slice(after.indexOf(raw) + 1);
    words = subcommandWords(program, after);
  }
  const [first = "", second = ""] = words;
  const named = `${program} ${first}`.trim();
  if (macTools.includes(program)) return { code: "mac-tool", subject: program };
  const native = nativeBuild(program, words);
  if (native !== null) return { code: "native-build", subject: native };
  if ((program === "expo" && /^(run|prebuild)/.test(first)) || named === "playwright install") {
    return { code: "mac-tool", subject: named };
  }
  if (program === "git" && GIT_WRITES.test(first)) return { code: "mac-state", subject: named };
  // A push changes no checkout, but Linux's copy has no `.git` and none of this Mac's credentials.
  if (named === "git push") return { code: "mac-repo", subject: named };
  if (entryOf(DEV_PROGRAMS, program)?.test(first) === true) {
    return { code: "serves-port", subject: named };
  }
  if (after.includes("--ui")) return { code: "serves-port", subject: `${program} --ui` };
  if (TASK_RUNNERS.has(program)) {
    for (const task of words) {
      const code = task.split(":").map(scriptCode).find(Boolean);
      if (code) return { code, subject: `${program} ${task}` };
    }
  }
  const watch = after.find(
    (word) => WATCH.test(word) || (word === "-w" && SHORT_WATCH.has(program)),
  );
  if (watch !== undefined) return { code: "watches", subject: `${program} ${watch}` };
  if (WATCHERS.has(program)) return { code: "watches", subject: program };
  if ((program === "vitest" && /^(watch|dev)$/.test(first)) || named === "tsx watch") {
    return { code: "watches", subject: named };
  }
  if (DOCKERS.has(program) && first !== "") {
    const docker = dockerReason(program, first, after);
    return inScript && docker?.code === "mac-docker" ? null : docker;
  }
  if (!PACKAGE_MANAGERS.has(program)) return null;
  const runs = first === "run" || first === "run-script";
  // `pnpm --filter web add x`: a flag's value can sit before the subcommand.
  const install = runs ? undefined : [first, second].find((word) => INSTALLS.test(word));
  if (install !== undefined && !inScript) {
    return { code: "mac-state", subject: `${program} ${install}` };
  }
  const script = runs ? second : first;
  const code = scriptCode(script);
  return code === null ? null : { code, subject: `${program} ${script}` };
};

/**
 * A line that runs until it is stopped: some part of it serves a port or watches. A queue slot
 * would be held for good, so it runs on this Mac outside the queue.
 */
export const neverEnds = (line: string, read?: ReadScript) =>
  readLine(line, read).parts.some((part) => {
    const code = part.handsOffInside ? undefined : programReason(part, [], false)?.code;
    return code === "serves-port" || code === "watches";
  });

/** The package.json script a package manager call runs (`pnpm test`, `npm run e2e`), or null. */
const scriptName = (values: ReadonlyArray<string>) => {
  if (!PACKAGE_MANAGERS.has(programName(values[0]))) return null;
  const [first, second] = subcommandWords(programName(values[0]), values.slice(1));
  return first === "run" || first === "run-script" ? (second ?? null) : (first ?? null);
};

const BROWSER_TOOL =
  /(^|[\s;&|()'"/])(playwright|cypress|puppeteer)(?=[\s;&|()'"]|$)|(^|\s)--browser(?=[\s=.]|$)/m;
const TEST_RUNNER = /(^|[\s;&|()'"/])(vitest|jest)(?=[\s;&|()'"]|$)|(^|[\s;&|()'"/])vp\s+test\b/m;
const BROWSER_DEPENDENCY =
  /^(playwright|playwright-core|@playwright\/test|@vitest\/browser.*|puppeteer|cypress)$/;

/**
 * Whether a Linux run needs Playwright's Chromium there (`REMOTO_BROWSER`): the command, or the
 * package.json script it runs, calls a browser tool or `--browser`; or it runs tests in a package
 * (of its folder or of a file it names) that depends on one. `read` gives a file's text or null.
 */
export const needsBrowser = (
  values: ReadonlyArray<string>,
  cwd: string,
  root: string,
  read: (path: string) => string | null,
): boolean => {
  const manifestOf = (dir: string): Record<string, unknown> | null => {
    for (let at = dir; inside(at, root); at = at.slice(0, at.lastIndexOf("/")) || "/") {
      const text = read(`${at}/package.json`);
      if (text !== null) {
        try {
          const json: unknown = JSON.parse(text);
          return json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      }
      if (at === root) break;
    }
    return null;
  };
  const field = (json: Record<string, unknown> | null, key: string) => {
    const value = json?.[key];
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  };
  const name = scriptName(values);
  const script = name === null ? undefined : field(manifestOf(cwd), "scripts")[name];
  const text = [...values, typeof script === "string" ? script : ""].join(" ");
  if (BROWSER_TOOL.test(text)) return true;
  if (!TEST_RUNNER.test(text)) return false;
  const named = values
    .slice(1)
    .filter((value) => !value.startsWith("-") && value.includes("/"))
    .map((value) => resolvePath(cwd, value));
  return [cwd, ...named.map((path) => path.slice(0, path.lastIndexOf("/")) || "/")].some((dir) => {
    const json = manifestOf(dir);
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some(
      (key) => Object.keys(field(json, key)).some((dep) => BROWSER_DEPENDENCY.test(dep)),
    );
  });
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
  listening: (port: number) => boolean,
  env: ReadonlyArray<string>,
  inScript: boolean,
): MacReason | null => {
  const own = programReason(part, config.runnerMacTools, inScript);
  if (own !== null) return own;
  const text = part.values.slice(part.remoteAt).join(" ");
  const pattern = config.runnerMacOnly.find((each) => matchesAny(text, [each]));
  if (pattern !== undefined) return { code: "pinned", subject: pattern.trim() };
  if (cwd === null) return null;
  // `remoto` syncs the checkout it runs from, so each part is judged against its own.
  const root = rootOf(cwd);
  if (root === null) return { code: "mac-env", subject: cwd };
  const { script } = part;
  const valueReason = (value: string): MacReason | null => {
    const path = outsidePath(value, cwd, root);
    if (path !== null) return { code: "mac-env", subject: path };
    const port = localPortsIn(value).find(listening);
    return port === undefined ? null : { code: "mac-port", subject: `localhost:${port}` };
  };
  for (const word of part.command.words.slice(part.programAt)) {
    // A script read with the job travels as its text; one unread or written by the line is here.
    if (
      word.value === script?.word
        ? script.body !== null && script.written !== true
        : word === part.command.words[part.programAt]
    ) {
      continue;
    }
    const expanded = expand(word, vars, cwd);
    const mac = "value" in expanded ? valueReason(expanded.value) : null;
    if (mac !== null) return mac;
  }
  for (const value of env) {
    const mac = valueReason(value);
    if (mac !== null) return mac;
  }
  return null;
};

const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash"]);

const programName = (path: string | undefined) => path?.split("/").pop() ?? "";

/** Where the text a shell runs with `-c` sits in its words (program first), or -1. */
const shellTextAt = (values: ReadonlyArray<string>) => {
  if (!SHELL_PROGRAMS.has(programName(values[0]))) return -1;
  const flag = values.findIndex((value, at) => at > 0 && /^-[a-z]*c[a-z]*$/.test(value));
  return flag < 0 || values[flag + 1] === undefined ? -1 : flag + 1;
};

/** The text a shell runs with `-c` (words program first), which goes to Linux whole. */
const shellTextOf = (values: ReadonlyArray<string>) => values[shellTextAt(values)];

/** Where a shell line's leading `cd` folders (from `lineParts`) land, starting at `cwd`. */
export const startFolder = (dirs: ReadonlyArray<string>, cwd: string, home: string) =>
  dirs.reduce((at, dir) => resolvePath(at, dir.replace(/^~(?=$|\/)/, home)), cwd);

/**
 * A part that names its own folder (a folder flag such as `pnpm -C`, or a `sh -c` text's leading
 * `cd`s) in another checkout than `cwd`'s: that folder, and its words (program first) with the
 * folder taken out, so Linux syncs that checkout and runs it from there. Null otherwise.
 */
export const movedPart = (
  values: ReadonlyArray<string>,
  cwd: string,
  home: string,
  rootOf: (cwd: string) => string | null,
): { readonly cwd: string; readonly values: ReadonlyArray<string> } | null => {
  let folder: string | undefined;
  let rest = values;
  const text = shellTextAt(values);
  if (text > 0) {
    const { dirs, command } = lineParts(values[text]!);
    if (dirs.length > 0) {
      folder = startFolder(dirs, cwd, home);
      rest = values.with(text, command);
    }
  } else {
    // ponytail: read before the subcommand only, as these tools take them.
    const flags = entryOf(FOLDER_FLAGS, programName(values[0])) ?? [];
    for (let at = 1; at < values.length; at++) {
      const value = values[at]!;
      const flag = flags.find((each) => value === each || value.startsWith(`${each}=`));
      if (flag !== undefined) {
        const joined = value !== flag;
        const named = joined ? value.slice(flag.length + 1) : values[at + 1];
        if (named === undefined) break;
        folder = resolvePath(cwd, named);
        rest = joined ? values.with(at, `${flag}=.`) : values.with(at + 1, ".");
        break;
      }
      if (!value.startsWith("-")) break;
    }
  }
  if (folder === undefined) return null;
  const root = rootOf(folder);
  return root !== null && root !== rootOf(cwd) ? { cwd: folder, values: rest } : null;
};

const literalValue = (word: Word, vars: ReadonlyMap<string, string | null>, cwd: string) => {
  const expanded = expand(word, vars, cwd);
  return "value" in expanded ? expanded.value : null;
};

const DECLARES = new Set(["export", "declare", "local", "readonly"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

const CASE_ARM = /(^|[\n;]|\sin)\s+\(?[^\s();]+\)(?=\s)/g;

const IN_PLACE: Readonly<Record<string, RegExp>> = {
  sed: /^(-[^-]*i|--in-place)/,
  perl: /^-\w*i/,
  ruby: /^-\w*i/,
};

/**
 * An edit into the checkout a text makes when Linux runs it whole: Linux's copy never comes back.
 * Redirects count only there; beside a heavy call this Mac's shell opens them.
 */
const editReason = (
  part: Part,
  cwd: string | null,
  vars: ReadonlyMap<string, string | null>,
  rootOf: (cwd: string) => string | null,
  redirects: boolean,
): MacReason | null => {
  const root = cwd === null ? null : rootOf(cwd);
  const intoCheckout = (word: Word) => {
    const value = cwd === null ? null : literalValue(word, vars, cwd);
    return root !== null && value !== null && inside(resolvePath(cwd!, value), root);
  };
  const { program } = part;
  const args = part.values.slice(part.programAt + 1);
  // An editor's files are relative to its folder: outside any checkout it edits nothing of one.
  const inPlace = root === null ? undefined : entryOf(IN_PLACE, program);
  const flag = inPlace && args.find((word) => inPlace.test(word));
  if (flag) return { code: "edits-in-place", subject: `${program} ${flag}` };
  if (program === "tee") {
    const file = part.command.words
      .slice(part.programAt + 1)
      .find((word) => !word.value.startsWith("-") && intoCheckout(word));
    if (file !== undefined) return { code: "edits-in-place", subject: `tee ${file.value}` };
  }
  if (!redirects) return null;
  for (const { op, target } of part.command.redirects) {
    if (target === null || op.includes("<") || op.endsWith("&") || !intoCheckout(target)) continue;
    return { code: "edits-in-place", subject: `${op.replace(/^\d+/, "")} ${target.value}` };
  }
  return null;
};

/**
 * The first reason a line's work must stay on this Mac. Only the work parts leave (heavy commands
 * and `remoto` calls; with none, every program the job runs), so only they are judged, each from
 * the folder it runs in. A script or `sh -c` text a part runs goes whole: one level of it is
 * judged like a line, in that part's copy.
 */
const lineReason = (
  line: string,
  start: string | null,
  context: Pick<WorkContext, "config" | "home" | "rootOf" | "listening" | "learned">,
  read: ReadScript | undefined,
  nested = false,
  inScript = false,
): MacReason | null => {
  const { config, home, rootOf, listening = () => false } = context;
  // Route memory's reason waits for the line's own: any of them wins over it.
  let learned: MacReason | null = null;
  const parsed = readLine(line, read);
  // The parser keeps a `case` arm's pattern as the command's first word: `a) xcodebuild` runs it.
  const source = parsed.unsafe === "case" ? line.replace(CASE_ARM, "$1\n") : line;
  const { parts } = source === line ? parsed : readLine(source, read);
  const work = new Set(workParts(parts));
  // A text sent whole, or a line with no heavy or `remoto` part, runs whole where it is sent.
  const whole = nested || !parts.some((part) => part.heavy || part.remoto !== null);
  const cwds = new Map<string, string | null>([["", start]]);
  const vars = new Map<string, string | null>([["HOME", home]]);
  // What reaches a command's environment from earlier in the line; plain `K=V;` does not.
  const exported = new Set<string>();
  const nameOf = (word: Word) => word.value.slice(0, word.value.indexOf("="));
  const assigned = (word: Word, cwd: string) =>
    literalValue(
      // `D=~/x` expands the `~` when it is not quoted.
      {
        ...word,
        value: word.value.slice(nameOf(word).length + 1),
        tilde: source[word.start + nameOf(word).length + 1] === "~",
      },
      vars,
      cwd,
    );
  const cwdAt = (scope: ReadonlyArray<number>): string | null => {
    const key = scope.join("/");
    if (!cwds.has(key)) cwds.set(key, cwdAt(scope.slice(0, -1)));
    return cwds.get(key)!;
  };
  for (const part of parts) {
    const { command } = part;
    const cwd = cwdAt(command.scope);
    if (whole || part.remoto !== null) {
      const edit = editReason(part, cwd, vars, rootOf, whole);
      if (edit !== null) return edit;
    }
    if (work.has(part)) {
      // A part naming a folder in another checkout runs from there (`linux-part` does the same).
      const moved =
        cwd === null
          ? null
          : movedPart(
              part.command.words
                .slice(part.remoteAt)
                .map((word) => literalValue(word, vars, cwd) ?? word.value),
              cwd,
              home,
              rootOf,
            );
      const at = moved?.cwd ?? cwd;
      const env = [
        ...command.assigns,
        ...command.words.slice(0, part.programAt).filter((word) => ASSIGNMENT.test(word.value)),
      ].map((word) => assigned(word, at ?? "/"));
      for (const name of exported) env.push(vars.get(name) ?? null);
      const mac = tieOf(
        part,
        at,
        vars,
        rootOf,
        config,
        listening,
        env.filter((value) => value !== null),
        inScript,
      );
      // A pattern matches the text a shell runs too: what that text runs says why first.
      if (mac !== null && mac.code !== "pinned") return mac;
      if (mac === null && at !== null) {
        learned ??= context.learned?.(part.values.slice(part.programAt), at) ?? null;
      }
      const given = shellTextOf(part.values.slice(part.programAt));
      // A text this shell builds (`sh -c "$(cat x)"`) shows what it does only when it runs.
      const built = part.command.words.some(
        (word) => word.value === given && word.vars.includes(""),
      );
      // A package.json script was read from the line's own folder: elsewhere it is another's.
      const elsewhere =
        part.script?.word.startsWith(PACKAGE_SCRIPT) === true && (moved !== null || cwd !== start);
      const scriptBody = elsewhere ? undefined : (part.script?.body ?? undefined);
      const body =
        scriptBody ??
        (built ? undefined : shellTextOf(moved?.values ?? part.values.slice(part.programAt)));
      if (body !== undefined) {
        const root = at === null ? null : rootOf(at);
        const inner = lineReason(
          body,
          at ?? start,
          { ...context, rootOf: (dir) => (root !== null && inside(dir, root) ? root : null) },
          // A script inside a `sh -c` text was read with the job; a script's own scripts are not.
          part.script === null ? read : undefined,
          // Only a text sent whole runs on Linux; a `sh -c` text in a job runs in this Mac's shell.
          whole || part.remoto !== null,
          inScript || scriptBody !== undefined,
        );
        if (inner?.code === "learned") learned ??= inner;
        else if (inner !== null) return inner;
      }
      if (mac !== null) return mac;
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
          ? command.words.slice(1).filter((word) => ASSIGNMENT.test(word.value))
          : [];
    for (const word of assignments) {
      vars.set(nameOf(word), command.conditional ? null : assigned(word, cwd ?? "/"));
    }
    if (first === "export") {
      for (const word of command.words.slice(1)) {
        if (/^[A-Za-z_]\w*(=|$)/.test(word.value)) exported.add(word.value.split("=")[0]!);
      }
    }
  }
  return learned;
};

/**
 * Whether Linux can run a job, and why not: Linux unless a part of its work has a reason from the
 * closed list (`MacReason`). A command it can't follow is no reason.
 */
export const eligibilityOf = (
  entry: Pick<QueuedEntry, "label" | "line" | "server" | "cwd" | "scripts">,
  context: Pick<WorkContext, "config" | "home" | "rootOf" | "listening" | "learned">,
): Verdict => {
  const line = lineOf(entry);
  if (kindOf(entry) === "exclusive") {
    return { eligibility: "exclusive", reason: `Always on this Mac: ${nameOf(line)}` };
  }
  const { scripts } = entry;
  const mac = lineReason(
    line,
    entry.cwd,
    context,
    scripts === undefined ? undefined : (word) => scripts[word] ?? null,
  );
  return mac === null ? { eligibility: "linux", reason: null } : macOnly(mac);
};

/** Why one expanded command (program first) must run on this Mac, as `linux-part` sees it. */
export const macReasonOf = (
  values: ReadonlyArray<string>,
  cwd: string,
  context: Pick<WorkContext, "config" | "home" | "rootOf" | "listening" | "learned">,
  read: ReadScript,
) => lineReason(values.map(shellQuote).join(" "), cwd, context, read);

export interface LinuxHealth extends Sustained {
  /** Null until a check settles it. */
  readonly online: boolean | null;
  readonly failures: number;
  readonly checkedAt: number | null;
  /** The last successful check. */
  readonly okAt: number | null;
  /** Busy share of its CPU, 0–100, like the Mac's; null without two readings to compare. */
  readonly cpuPercent: number | null;
  /** The one-minute load, a hint only: it counts waiting tasks, not CPU in use. */
  readonly load1: number | null;
  readonly cpuCount: number | null;
  readonly availableMemoryBytes: number | null;
  readonly totalMemoryBytes: number | null;
  readonly error?: string;
  /** When the last failure counted; a check's claim moves `checkedAt` before it runs. */
  readonly failedAt?: number;
  /** When it last came back online after being offline. */
  readonly backOnlineAt?: number;
  /** Seconds since Linux booted, as of `okAt`. */
  readonly uptimeSeconds?: number;
}

export const UNKNOWN_HEALTH: LinuxHealth = {
  online: null,
  failures: 0,
  checkedAt: null,
  okAt: null,
  cpuPercent: null,
  load1: null,
  cpuCount: null,
  availableMemoryBytes: null,
  totalMemoryBytes: null,
  overLimit: false,
  overLimitSince: null,
  underLimitSince: null,
};

export interface LinuxReading {
  readonly cpuPercent: number | null;
  readonly load1: number | null;
  readonly cpuCount: number | null;
  readonly availableMemoryBytes: number | null;
  readonly totalMemoryBytes: number | null;
  readonly uptimeSeconds?: number;
}

/**
 * The busy share between two `/proc/stat` `cpu` lines, 0–100: busy is all but idle and iowait,
 * over user..steal (guest time is already inside user and nice). Null when either line is
 * missing or the counters did not move forward.
 */
const cpuPercentBetween = (before: string | undefined, after: string | undefined) => {
  const times = (line: string | undefined) => {
    const fields = line?.trim().split(/\s+/).slice(1, 9).map(Number) ?? [];
    return fields.length === 8 && fields.every(Number.isFinite) ? fields : null;
  };
  const [a, b] = [times(before), times(after)];
  if (a === null || b === null) return null;
  const total = b.reduce((sum, n) => sum + n, 0) - a.reduce((sum, n) => sum + n, 0);
  const idle = b[3]! + b[4]! - (a[3]! + a[4]!);
  if (!(total > 0) || idle < 0 || idle > total) return null;
  return ((total - idle) / total) * 100;
};

/** `HEARTBEAT_COMMAND` output. */
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
  const [before, after] = lines.filter((line) => /^cpu\s/.test(line));
  // `/proc/uptime`: the only line of exactly two numbers.
  const uptime = lines.find((line) => /^\d+(\.\d+)?\s+\d+(\.\d+)?$/.test(line.trim()));
  return {
    cpuPercent: cpuPercentBetween(before, after),
    load1: value(load1),
    cpuCount: Number.isInteger(cpuCount) && cpuCount > 0 ? cpuCount : null,
    totalMemoryBytes: value(total),
    availableMemoryBytes: value(available),
    ...(uptime === undefined ? {} : { uptimeSeconds: Number(uptime.trim().split(/\s+/)[0]) }),
  };
};

export type HealthCheck =
  | { readonly ok: true; readonly reading: LinuxReading }
  | { readonly ok: false; readonly error: string };

const GIB = 1024 ** 3;

/** Which of Linux's own limits a reading is past, for the waiting reason; null when none or unknown. */
const linuxOverBy = (reading: LinuxReading, machine: RunnerMachineConfig): string | null => {
  const { availableMemoryBytes: free, totalMemoryBytes: total, cpuPercent: cpu } = reading;
  const floor = machine.runnerLinuxMemoryFloorPercent;
  if (free !== null && total !== null && free < (floor / 100) * total) {
    return `${(Math.max(0, free) / GIB).toFixed(1)} GB free, keeping ${floor}%`;
  }
  if (cpu === null) return null;
  return cpu > machine.runnerLinuxCpuCeilingPercent
    ? `CPU ${Math.round(cpu)}%, limit ${machine.runnerLinuxCpuCeilingPercent}%`
    : null;
};

/** Readings further apart than this are not one run of them: one missed beat at most. */
const readingGapMs = (machine: RunnerMachineConfig) =>
  2 * (machine.runnerHeartbeatSeconds + machine.runnerSshTimeoutSeconds) * 1000;

// A start shows its weight only once it warms up: the next waits for a reading this long after.
export const LINUX_SETTLE_MS = 60_000;

// Half the entry floor, so a stop never makes room that lets the same start back in at once.
export const LINUX_EVICT_SHARE = 0.5;

/** When Linux last booted, from the latest reading; null without one. */
export const bootAtOf = (health: LinuxHealth) =>
  health.okAt === null || health.uptimeSeconds === undefined
    ? null
    : health.okAt - health.uptimeSeconds * 1000;

/** Started before Linux last booted, with a second's slack for the reading's own delay. */
export const beforeBoot = (bootAt: number | null, startedAt: number) =>
  bootAt !== null && startedAt < bootAt - 1000;

/**
 * Running Linux attempts to stop after a reading: every one from before Linux restarted, and,
 * once memory falls below half the floor, the newest of two or more. Never the only one (alone,
 * a job that fills memory is its own problem) and one at a time: the next waits for a reading
 * taken after the last stop.
 */
export const linuxStops = (
  health: LinuxHealth,
  entries: ReadonlyArray<HeavyQueueEntry>,
  machine: RunnerMachineConfig,
): Readonly<Record<string, "memory" | "reboot">> => {
  const stops: Record<string, "memory" | "reboot"> = {};
  const running = entries.filter((entry) => entry.startedAt !== null && entry.runner === "linux");
  const bootAt = bootAtOf(health);
  for (const entry of running) {
    if (beforeBoot(bootAt, Date.parse(entry.startedAt!))) stops[entry.id] = "reboot";
  }
  const { okAt, availableMemoryBytes: free, totalMemoryBytes: total } = health;
  const floor = (machine.runnerLinuxMemoryFloorPercent / 100) * LINUX_EVICT_SHARE;
  if (okAt === null || free === null || total === null || !(free < total * floor)) return stops;
  const live = running.filter(
    (entry) => (entry as QueuedEntry).stop === undefined && stops[entry.id] === undefined,
  );
  const stopping = running.some((entry) => (entry as QueuedEntry).stop === "memory");
  const settling = entries.some((entry) => ((entry as QueuedEntry).evictedAt ?? -1) >= okAt);
  if (live.length < 2 || stopping || settling) return stops;
  const newest = live.reduce((a, b) =>
    Date.parse(b.startedAt!) > Date.parse(a.startedAt!) ? b : a,
  );
  stops[newest.id] = "memory";
  return stops;
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
  // Failures closer than half a heartbeat apart are one outage seen twice (jobs failing together).
  const sameEvent =
    !check.ok &&
    previous.failures > 0 &&
    previous.failedAt !== undefined &&
    now - previous.failedAt < (machine.runnerHeartbeatSeconds * 1000) / 2;
  if (sameEvent) return { ...previous, error: check.error };
  if (check.ok) {
    // One missed beat keeps the run of readings; a longer silence starts over from "has room".
    const continuous = previous.okAt !== null && now - previous.okAt <= readingGapMs(machine);
    const over = linuxOverBy(check.reading, machine) !== null;
    const backOnlineAt = previous.online === false ? now : previous.backOnlineAt;
    return {
      online: true,
      failures: 0,
      checkedAt: now,
      okAt: now,
      ...(backOnlineAt === undefined ? {} : { backOnlineAt }),
      ...check.reading,
      ...sustain(continuous ? previous : null, over, now, windowMs),
    };
  }
  const failures = previous.failures + 1;
  return {
    ...previous,
    // One failure never takes Linux offline, whatever the setting says.
    online: failures >= Math.max(2, machine.runnerOfflineAfterFailures) ? false : previous.online,
    failures,
    checkedAt: now,
    failedAt: now,
    error: check.error,
  };
};

/**
 * Linux can take this entry: the heartbeat says online and no `remoto` failed it since. An
 * environment failure would only repeat on the same Linux: it needs Linux to have been offline
 * and come back since, unless the user sent it there.
 */
const linuxUpFor = (health: LinuxHealth, entry: HeavyQueueEntry) => {
  const { linuxFailedAt, failure, route } = entry as QueuedEntry;
  if (health.online !== true || linuxFailedAt === undefined) return health.online === true;
  const since = failure !== undefined && route === undefined ? health.backOnlineAt : health.okAt;
  return (since ?? 0) > linuxFailedAt;
};

/** Runs that may lose the link before a job counts Linux unavailable: one past going offline. */
export const linkAttempts = (machine: RunnerMachineConfig) =>
  Math.max(2, machine.runnerOfflineAfterFailures) + 1;

/**
 * A failed run "If a Linux run fails" decides: its environment failed there, or it lost Linux on
 * its last attempt. Before that, a dropped run (the link, or the PC restarting) goes back by itself.
 */
const droppedFinal = (entry: HeavyQueueEntry, machine: RunnerMachineConfig) => {
  const { failure, linkFailures = 1 } = entry as QueuedEntry;
  return entry.dropped === true && (failure !== undefined || linkFailures >= linkAttempts(machine));
};

/**
 * A job whose run lost the link (not its environment) goes back to Linux by itself: at once when
 * a heartbeat gets through after the failure, else after a backoff that doubles each time.
 */
const linkRetry = (
  health: LinuxHealth,
  entry: HeavyQueueEntry,
  machine: RunnerMachineConfig,
  now: number,
): "retry" | "wait" | null => {
  const { linuxFailedAt } = entry;
  const { linkFailures = 1, failure } = entry as QueuedEntry;
  if (linuxFailedAt === undefined || failure !== undefined || health.online === false) return null;
  if (linkFailures >= linkAttempts(machine)) return null;
  const backoffMs = machine.runnerSshTimeoutSeconds * 1000 * 2 ** (linkFailures - 1);
  return now >= linuxFailedAt + backoffMs ? "retry" : "wait";
};

/** The kernel's own pressure scale (1, 2, 4), or 2 while swapping in; 1 with no reading. */
const strainOf = (sample: Sample | null) =>
  sample === null
    ? 1
    : Math.max(
        1,
        sample.pressureLevel ?? 1,
        (sample.swapInBytesPerSecond ?? 0) > SWAP_IN_LIMIT ? 2 : 1,
      );

/** ssh's start and handshake slow down while this Mac swaps: its timeout grows with the strain. */
export const linkMachine = (machine: RunnerMachineConfig, sample: Sample | null) => ({
  ...machine,
  runnerSshTimeoutSeconds: machine.runnerSshTimeoutSeconds * strainOf(sample),
});

export interface WorkContext {
  readonly config: RunnerProjectConfig;
  /** Two jobs of one worktree never run on Linux together: `remoto` would serialize them. */
  readonly worktree: string;
  readonly home: string;
  /** The git checkout `remoto` would sync from a folder, or null outside any. */
  readonly rootOf: (cwd: string) => string | null;
  /** Whether something on this Mac listens on a TCP port; nothing does when absent. */
  readonly listening?: (port: number) => boolean;
  /** Route memory's reason to keep a call (program first) in `cwd` here; none when absent. */
  readonly learned?: (values: ReadonlyArray<string>, cwd: string) => MacReason | null;
}

export interface RoutePlanInput extends PlanInput {
  readonly contextOf: (cwd: string) => WorkContext;
  readonly machine: RunnerMachineConfig;
  readonly health: LinuxHealth;
  /** Some project uses the Runner: Mac rows then say why they stay. */
  readonly runnerOn?: boolean;
  /** Folders of runs Linux hasn't confirmed stopped: their worktrees start nothing there until it does. */
  readonly lostCwds?: ReadonlyArray<string>;
}

interface LinuxBusy {
  readonly kind: "slots" | "worktree" | "limits" | "reading";
  readonly why: string;
  /** Held for a job that runs there alone: never "full" for "When Linux is full". */
  readonly alone?: true;
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
  /** Waiters "When Linux is full" moved to this Mac, with why: they stay there (`route`). */
  readonly moved: Readonly<Record<string, string>>;
  readonly room: boolean;
  readonly holding: boolean;
  readonly mac: Plan | null;
}

const askExpired = (entry: HeavyQueueEntry, now: number) =>
  entry.ask !== undefined && Date.parse(entry.ask.deadlineAt) <= now;

/**
 * A failed run keeps its policy until it resolves: "Run on this Mac" and an unanswered question
 * are not undone by the next good heartbeat. Waiting (chosen, or an expired question) ends the
 * hold. A drop with attempts left is no failure yet: that run goes back by itself.
 */
const dropHolds = (
  entry: HeavyQueueEntry,
  config: RunnerProjectConfig,
  machine: RunnerMachineConfig,
  now: number,
) =>
  droppedFinal(entry, machine) &&
  entry.route === undefined &&
  (config.runnerDropped === "mac" ||
    config.runnerDropped === "agent" ||
    (config.runnerDropped === "ask" &&
      !(askExpired(entry, now) && config.runnerDeadlineAction === "wait")));

/** A running job's own call, queued by it: the slot it would wait for is its job's. */
const isCall = (entry: HeavyQueueEntry) => (entry as QueuedEntry).call === true;

/**
 * The job was started with `--runner linux`: it never changes machine, in the plan or in its
 * calls. An agent's `remoto` and a job's own call queued for Linux did not ask; they follow the
 * settings, so with Linux offline they may run here.
 */
export const askedLinux = (entry: HeavyQueueEntry) =>
  entry.where === "linux" && !isCall(entry) && (entry as QueuedEntry).linuxOnly === true;

/** `--runner mac` with no reason given, on work Linux could run: kept here, and said so. */
export const ASKED_MAC_NEEDLESSLY =
  "Asked for this Mac, but nothing here needs it: drop --runner mac so the PC can take it";

const RUNNER_OFF_ASKED = "The Runner is off for this project and this job asked for Linux";

/**
 * Where the entry's own settings send it before Linux health is considered. `cancel`: it asked for
 * Linux but must run on this Mac.
 */
export const intentOf = (
  entry: HeavyQueueEntry,
  context: WorkContext,
): { readonly intent: RunnerWhere; readonly reason: string; readonly cancel?: string } => {
  const mac = (reason: string) => ({ intent: "mac" as const, reason });
  if (!context.config.runnerEnabled) {
    const why = "Runner off for this project";
    return askedLinux(entry) ? { ...mac(why), cancel: RUNNER_OFF_ASKED } : mac(why);
  }
  const verdict = eligibilityOf(entry, context);
  if (verdict.eligibility === "exclusive" || verdict.eligibility === "mac-only") {
    const reason = verdict.reason!;
    return askedLinux(entry)
      ? { ...mac(reason), cancel: `Asked for Linux, but it needs this Mac: ${reason}` }
      : mac(reason);
  }
  if (entry.route === "mac") return mac((entry as QueuedEntry).routeReason ?? "Moved to this Mac");
  if (entry.route === "linux") return { intent: "linux", reason: "" };
  // `--runner` (an agent's own `remoto` call) speaks for the job; otherwise only listed work leaves.
  const where = entry.where ?? (verdict.reason === null ? context.config.runnerWhere : "mac");
  if (where !== "mac") return { intent: where, reason: "" };
  return mac(
    verdict.reason ??
      (entry.where === "mac"
        ? ((entry as QueuedEntry).routeReason ?? ASKED_MAC_NEEDLESSLY)
        : "Runner set to this Mac"),
  );
};

/** Why this Mac took a job Linux couldn't start now, worded for the Mac's row. */
const macTookWhy = (busy: LinuxBusy) =>
  busy.kind === "slots"
    ? "Linux is full"
    : busy.kind === "limits"
      ? "Linux is at its limits"
      : busy.kind === "reading"
        ? "no fresh reading of Linux's load"
        : busy.why;

/**
 * Decides every waiter in queue order. Automatic: Linux whenever it can start the job now; else
 * this Mac, if it has room and no waiter; else the job waits for Linux. Mac first: this Mac up to
 * `runnerMacFirstAfter` jobs, then Linux, a full Mac yielding to a Linux that can start it now.
 * Past both sustained limits, the job holds. Neither asks: Linux offline or unknown keeps it here.
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
  const lostWorktrees = new Set((input.lostCwds ?? []).map((cwd) => input.contextOf(cwd).worktree));
  let linuxFree = machine.runnerLinuxSlots - linuxRunning.length;
  /** Stopped for memory often enough to run on Linux alone (`runnerLinuxEvictionsBeforeAlone`). */
  const runsAlone = (entry: HeavyQueueEntry) =>
    ((entry as QueuedEntry).evictions ?? 0) >= machine.runnerLinuxEvictionsBeforeAlone;
  /** Jobs waiting for Linux to empty: it admits nobody else meanwhile. */
  const alone = new Set(waiting.filter(runsAlone).map((entry) => entry.id));
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
  const linuxOverNow = linuxOverBy(health, machine);
  const okAt = health.okAt ?? -Infinity;
  const stale = now - okAt > readingGapMs(machine);

  const admits: Record<string, Admit> = {};
  const routes: Record<string, HeavyRunner> = {};
  const reasons: Record<string, string> = {};
  const asks: Record<string, HeavyRunnerAskReason> = {};
  const cancels: Record<string, string> = {};
  const moved: Record<string, string> = {};
  const linuxOver: Record<string, string> = {};
  const macWaiters: HeavyQueueEntry[] = [];
  /** Why each job runs on this Mac, shown with what it waits for there. */
  const macWhy: Record<string, string> = {};

  /** Mac rows say why only once a Runner is on. */
  const shows = input.runnerOn === true;
  const toMac = (entry: HeavyQueueEntry, reason: string) => {
    alone.delete(entry.id);
    if (shows) macWhy[entry.id] = reason;
    routes[entry.id] = "mac";
    macCount += 1;
    if (!queueOn) admits[entry.id] = { runner: "mac", ungated: true };
    // Its job's slot is its own: waiting for another could wait on that job (pause included). A
    // Linux call sent here leaves the queue instead, to run under its job (`leavesForMac`).
    else if (isCall(entry) && entry.where === "mac") {
      admits[entry.id] = { runner: "mac", ungated: false };
    } else macWaiters.push(entry);
  };
  // A running job keeps saying why it runs on this Mac, as its row did while it waited.
  for (const entry of macRunning) {
    const why = (entry as QueuedEntry).routeReason;
    if (why !== undefined && shows) reasons[entry.id] = why;
  }
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
  /** Why Linux cannot take `entry` (of `worktree`) now, or null when it can. */
  const linuxBusy = (entry: HeavyQueueEntry, worktree: string): LinuxBusy | null => {
    if (linuxFree <= 0 && !isCall(entry)) {
      return { kind: "slots", why: `all ${machine.runnerLinuxSlots} Linux slots are busy` };
    }
    // Its stop check there would end the new run too, in the same folder.
    if (lostWorktrees.has(worktree)) {
      return {
        kind: "worktree",
        why: "Linux hasn't confirmed an earlier run of this worktree stopped",
      };
    }
    if (busyWorktrees.has(worktree)) {
      return { kind: "worktree", why: "this worktree is already running on Linux" };
    }
    // Linux drains for a job that runs there alone: admitting others would starve it.
    if (!isCall(entry) && [...alone].some((id) => id !== entry.id)) {
      return {
        kind: "slots",
        why: "Linux is kept free for a job that runs there alone",
        alone: true,
      };
    }
    if (stale) return { kind: "reading", why: "a fresh reading of Linux" };
    if (health.overLimit) {
      return { kind: "limits", why: linuxOverNow ?? "easing back under its limits" };
    }
    // Only the sustained limits move work elsewhere, but no new start goes past the instant ones.
    if (linuxOverNow !== null) return { kind: "limits", why: linuxOverNow };
    // Bounds stop and start on a job that only fits there alone.
    if (runsAlone(entry) && linuxFree < machine.runnerLinuxSlots) {
      return {
        kind: "limits",
        why: "Linux ran short of memory beside other jobs: waiting to run there alone",
        alone: true,
      };
    }
    if (okAt < lastLinuxStart + LINUX_SETTLE_MS) {
      return { kind: "reading", why: "a reading a minute after the last job started there" };
    }
    return null;
  };
  /** Each machine's wait for `entry` in rounds of its slots; one that can't start it now counts one. */
  /**
   * Nothing but its slots keeps this Mac from starting `entry`: no sustained or instant limit, no
   * job running alone, and the job fits beside the others. A Linux-full move is for good, so a
   * Mac holding the job back for any other reason never takes it.
   */
  const macTakes = (entry: HeavyQueueEntry) =>
    !macOver &&
    !macExclusive &&
    (!queueOn ||
      macCount === 0 ||
      !fresh ||
      (machineHold(sample, input) === null && jobVerdict(input, sample, entry).hold === null));
  const macWaitsLess = (entry: HeavyQueueEntry) => {
    const macSlots = Math.max(1, input.maxRunning);
    const macWait = macRoom(entry) ? 0 : Math.max(1, macCount + 1 - macSlots) / macSlots;
    const linuxSlots = machine.runnerLinuxSlots;
    return macWait < Math.max(1, linuxCount + 1 - linuxSlots) / linuxSlots;
  };
  /**
   * "When Linux is full", in Linux mode: a waiter that only Linux's slots or limits hold back may
   * take this Mac. A job that asked for Linux, a job's own call or a chosen wait never moves.
   */
  const linuxFullRoute = (entry: HeavyQueueEntry, config: RunnerProjectConfig, busy: LinuxBusy) => {
    const full =
      config.runnerWhere === "linux" &&
      (busy.kind === "slots" || busy.kind === "limits") &&
      busy.alone !== true &&
      !askedLinux(entry) &&
      !isCall(entry) &&
      entry.route !== "linux";
    const policy = full ? config.runnerLinuxFull : "wait";
    const move = (reason: string) => {
      moved[entry.id] = reason;
      toMac(entry, reason);
    };
    if (policy === "mac" && macTakes(entry) && macRoom(entry)) return move(LINUX_FULL_MAC);
    if (policy === "balance" && macTakes(entry) && macWaitsLess(entry)) {
      return move(LINUX_FULL_SHORTER);
    }
    toLinux(entry, busy);
    if (policy === "balance") reasons[entry.id] = LINUX_FULL_WAITING;
  };
  /** Start now skips Linux's wait, but not a run of the same worktree that `remoto` would serialize. */
  const startsOnLinux = (entry: HeavyQueueEntry, busy: LinuxBusy) =>
    entry.forced === true && busy.kind !== "worktree";
  /**
   * "When Linux is offline" or "If a Linux run fails", with its question and deadline. A run Linux
   * hasn't confirmed stopped reruns nowhere yet, but every other choice acts now.
   */
  const follow = (entry: HeavyQueueEntry, config: RunnerProjectConfig) => {
    const reason: HeavyRunnerAskReason = droppedFinal(entry, machine) ? "dropped" : "unavailable";
    const policy = reason === "dropped" ? config.runnerDropped : config.runnerUnavailable;
    const { failure } = entry as QueuedEntry;
    const what =
      failure !== undefined
        ? `Linux couldn't run this: ${failure}`
        : reason === "dropped"
          ? "Linux dropped it mid-run"
          : "Linux is unavailable";
    const unconfirmed = entry.unconfirmed === true;
    const asked = askedLinux(entry);
    const refused =
      what === "Linux is unavailable"
        ? "Linux is offline and this job asked for Linux"
        : `${what}, and this job asked for Linux`;
    const cancel = (why: string) => {
      routes[entry.id] = "linux";
      cancels[entry.id] = unconfirmed ? `${why}, and hasn't confirmed it stopped there` : why;
    };
    const runHere = (why: string) => {
      if (asked) return cancel(refused);
      if (!unconfirmed) return toMac(entry, why);
      routes[entry.id] = "mac";
      reasons[entry.id] = `${what}: running here once Linux confirms it stopped`;
    };
    // Tell the agent: a job Linux dropped or couldn't run ends with that, never rerunning here.
    if (policy === "agent") {
      return cancel(asked ? refused : `Linux couldn't run this: ${failure ?? what}`);
    }
    if (policy === "mac") return runHere(`${what}: running here`);
    if (policy === "wait") return toLinux(entry, `${what}: waiting for it`);
    if (entry.ask === undefined) {
      asks[entry.id] = reason;
      return toLinux(entry, `${what}: asking you`);
    }
    if (!askExpired(entry, now)) return toLinux(entry, `${what}: waiting for your answer`);
    if (config.runnerDeadlineAction === "mac") {
      return runHere(`${what} and nobody answered: running here`);
    }
    if (config.runnerDeadlineAction === "wait") {
      return toLinux(entry, `${what}: no answer, waiting for it`);
    }
    cancel(`${what} and nobody answered in time: canceled`);
  };
  const toLinuxNow = (entry: HeavyQueueEntry, worktree: string, reason: string) => {
    alone.delete(entry.id);
    routes[entry.id] = "linux";
    reasons[entry.id] = reason;
    linuxCount += 1;
    linuxFree -= 1;
    busyWorktrees.add(worktree);
    lastLinuxStart = now;
    admits[entry.id] = { runner: "linux", ungated: !queueOn };
  };

  for (const entry of macRunning) {
    const { intent, reason } = intentOf(entry, input.contextOf(entry.cwd));
    if (intent === "mac" && shows) macWhy[entry.id] = reason;
  }
  for (const entry of waiting) {
    const context = input.contextOf(entry.cwd);
    const { config, worktree } = context;
    const { intent, reason: why, cancel } = intentOf(entry, context);
    if (cancel !== undefined) {
      routes[entry.id] = "linux";
      cancels[entry.id] = cancel;
      continue;
    }
    if (entry.unconfirmed === true) {
      // This Mac never shares the lost run's folder, whose record holds back only Linux: work bound
      // here runs now, so a Runner turned off, which confirms nothing, never strands it.
      if (intent === "mac") {
        toMac(entry, why);
        continue;
      }
      // Linux offline, or the run's last attempt: its policy acts now. Otherwise, or once the user
      // chose, it just waits to confirm.
      if (entry.route === undefined && (health.online === false || droppedFinal(entry, machine))) {
        follow(entry, config);
        continue;
      }
      routes[entry.id] = entry.route ?? "linux";
      reasons[entry.id] = "Linux dropped it mid-run: confirming it stopped there before rerunning";
      continue;
    }
    if (intent === "mac") {
      toMac(entry, why);
      continue;
    }
    const retry = linkRetry(health, entry, machine, now);
    const up =
      (linuxUpFor(health, entry) || retry === "retry") && !dropHolds(entry, config, machine, now);
    // A lost link is Linux's: the job waits for it while it retries. A strained Mac holds only a
    // start here, which its own plan does.
    if (!up && retry === "wait" && !paused) {
      toLinux(entry, "waiting for Linux to come back");
      continue;
    }
    // A run that failed on Linux follows "If a Linux run fails" in every mode, below.
    if (
      (intent === "automatic" || intent === "macFirst") &&
      (up || !droppedFinal(entry, machine))
    ) {
      const hybrid = intent === "automatic";
      const mode = hybrid ? "Automatic" : "Mac first";
      if (hybrid && paused) {
        toMac(entry, "Automatic: queue paused");
        continue;
      }
      if (!up) {
        toMac(entry, `${mode}: Linux is unavailable`);
        continue;
      }
      const busy = linuxBusy(entry, worktree);
      if (macOver && health.overLimit && !(busy !== null && startsOnLinux(entry, busy))) {
        routes[entry.id] = "linux";
        linuxCount += 1;
        reasons[entry.id] = BOTH_AT_LIMITS;
        continue;
      }
      const past = macCount >= config.runnerMacFirstAfter;
      let onMac: boolean;
      if (hybrid) {
        onMac =
          busy !== null && !startsOnLinux(entry, busy) && macWaiters.length === 0 && macRoom(entry);
      } else {
        onMac = !macOver && (!past || health.overLimit);
        // Under its count, a full Mac still yields to a Linux that can start it now.
        if (onMac && busy === null && !macRoom(entry)) onMac = false;
      }
      if (onMac) {
        toMac(
          entry,
          hybrid && busy !== null
            ? `This Mac took it: ${macTookWhy(busy)}`
            : "Mac first: this Mac has room",
        );
        continue;
      }
      const macFirstWhy = past
        ? `Mac first: this Mac has ${macCount} job${macCount === 1 ? "" : "s"}`
        : "Mac first: this Mac has no room";
      if (paused && entry.forced !== true) toLinux(entry, "paused");
      else if (busy === null || startsOnLinux(entry, busy)) {
        toLinuxNow(entry, worktree, hybrid ? "Linux first: the PC can start it now" : macFirstWhy);
      } else {
        toLinux(entry, busy);
        if (hybrid) {
          const why = busy.kind === "reading" ? "no fresh reading of its load" : busy.why;
          reasons[entry.id] = `Linux can't start it yet: ${why}`;
        } else if (past) reasons[entry.id] = macFirstWhy;
      }
      continue;
    }
    // Bound for Linux.
    if (paused && !(up && entry.forced === true)) {
      toLinux(entry, "paused");
      continue;
    }
    if (up) {
      const busy = linuxBusy(entry, worktree);
      if (busy !== null && !startsOnLinux(entry, busy)) linuxFullRoute(entry, config, busy);
      else {
        toLinuxNow(
          entry,
          worktree,
          entry.route === "linux"
            ? "Moved to Linux"
            : askedLinux(entry)
              ? "Asked for Linux"
              : entry.where === "linux"
                ? "Sent to Linux with remoto"
                : "Runner set to Linux",
        );
      }
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
    follow(entry, config);
  }

  if (!queueOn) {
    return {
      admits,
      routes,
      reasons: { ...macWhy, ...reasons },
      linuxOver,
      asks,
      cancels,
      moved,
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
    moved,
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
  /** The program the pre-flight found missing there, which therefore never started. */
  readonly missing: string | null;
  /** A package whose install the wrapper could not finish there before the command. */
  readonly install: string | null;
  /** The command itself started: its output may print markers, so only `exit=` still counts. */
  readonly commandStarted: boolean;
}

export const NO_PROGRESS: RemoteProgress = {
  syncing: false,
  running: false,
  phase: null,
  id: null,
  pgid: null,
  exit: null,
  missing: null,
  install: null,
  commandStarted: false,
};

/**
 * Folds one marker line (`phase=running pgid=123`, `exit=0`) into the progress so far. After
 * `phase=command` only `remoto`'s own `exit=` folds; any other marker is the command's output and
 * returns `progress` itself.
 */
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
  // ponytail: the command can still print an `exit=`; a per-run nonce in the markers closes that.
  if (progress.commandStarted) {
    const exit = int(fields.exit);
    return exit === null ? progress : { ...progress, exit };
  }
  // A group of 0 or 1 is never a run's own: `kill -- -1` would reach every process there.
  const group = int(fields.pgid);
  return {
    syncing: progress.syncing || phase === "syncing",
    running: progress.running || phase === "running",
    phase:
      phase === "syncing" || phase === "installing" || phase === "running" ? phase : progress.phase,
    id:
      typeof fields.id === "string" && /^[A-Za-z0-9._-]+$/.test(fields.id)
        ? fields.id
        : progress.id,
    pgid: group !== null && group > 1 ? group : progress.pgid,
    exit: int(fields.exit) ?? progress.exit,
    missing:
      typeof fields.missing === "string" && fields.missing !== ""
        ? fields.missing
        : progress.missing,
    install:
      typeof fields.install === "string" && fields.install !== ""
        ? fields.install
        : progress.install,
    commandStarted: phase === "command",
  };
};

export type RemoteOutcome =
  | { readonly kind: "finished"; readonly code: number }
  /** The command never started there; `touched` when `remoto` got as far as syncing. */
  | { readonly kind: "unavailable"; readonly touched: boolean }
  /** It started there and the connection ended without its exit code. */
  | { readonly kind: "dropped" }
  /** The pre-flight found its program missing there: nothing ran. */
  | { readonly kind: "missing"; readonly tool: string };

/** The exit marker is the command's own code; without it, ssh's 255 is not the command's. */
export const remoteOutcome = (progress: RemoteProgress): RemoteOutcome => {
  if (progress.missing !== null) return { kind: "missing", tool: progress.missing };
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

// Two `/proc/stat` readings half a second apart: CPU in use now, with no state between heartbeats.
// `/proc/uptime` dates the last boot, so runs from before a restart are known to be gone.
export const HEARTBEAT_COMMAND =
  "cat /proc/loadavg; nproc; free -b; head -1 /proc/stat; sleep 0.5; head -1 /proc/stat; cat /proc/uptime";

/**
 * Stops what is left of run `id` there: its process group, then anything still naming its
 * folder. TERM, up to `waitSeconds` for it to go, then KILL. Prints `gone` when nothing ran,
 * `stopped` or `killed` when it is gone now, and `alive` (exit 1) when it survived.
 */
export const remoteStopScript = (
  id: string,
  pgid: number | null,
  waitSeconds: number,
  pgidOnly = false,
) => {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe run id: ${id}`);
  if (pgid !== null && !(Number.isSafeInteger(pgid) && pgid > 1)) {
    throw new Error(`Unsafe process group: ${pgid}`);
  }
  if (pgidOnly && pgid === null) throw new Error("A stop by process group needs one");
  // `[r]uns/…` keeps the pattern from matching the shell running this very script. A rerun owns the
  // folder under `pgidOnly`: neither the pattern nor the pgid file it rewrites names the lost run.
  const pattern = `[r]uns/${id}( |/|$)`;
  const byFolder = (command: string) => (pgidOnly ? "" : ` ${command};`);
  // `remoto-rodar` tags the copy's commands (`REMOTO_RUN=<id>:<nonce>`): this also reaches the
  // ones that left its process group, as a daemon or `setsid` does.
  const tag = `^REMOTO_RUN=${id.replaceAll(".", "\\.")}:`;
  return [
    `p=${pgid ?? ""};${pgidOnly ? "" : ` [ -n "$p" ] || p=$(cat "runs/${id}.pgid" 2>/dev/null)`}`,
    `case "$p" in *[!0-9]*|0|1) p= ;; esac`,
    // After a restart the number may name someone else's group: use it only while one of its
    // processes still works inside the run's folder, where `remoto-rodar` started it.
    `owned() { for q in $(pgrep -g "$p" 2>/dev/null); do case "$(readlink "/proc/$q/cwd" 2>/dev/null)" in "$HOME/runs/${id}"|"$HOME/runs/${id}/"*) return 0 ;; esac; done; return 1; }`,
    `[ -z "$p" ] || owned || p=`,
    ...(pgidOnly
      ? []
      : [
          `tagged() { for e in /proc/[0-9]*/environ; do grep -qzs '${tag}' "$e" && { q=\${e#/proc/}; echo "\${q%/environ}"; }; done; }`,
        ]),
    `alive() { { [ -n "$p" ] && kill -0 -- "-$p"; } 2>/dev/null${pgidOnly ? "" : ` || pgrep -f '${pattern}' >/dev/null || [ -n "$(tagged)" ]`}; }`,
    `alive || { echo gone; exit 0; }`,
    `{ [ -n "$p" ] && kill -TERM -- "-$p";${byFolder(`pkill -TERM -f '${pattern}'; kill -TERM $(tagged)`)} } 2>/dev/null`,
    `i=0; while alive && [ "$i" -lt ${Math.max(1, Math.floor(waitSeconds))} ]; do sleep 1; i=$((i+1)); done`,
    `alive || { echo stopped; exit 0; }`,
    `{ [ -n "$p" ] && kill -KILL -- "-$p";${byFolder(`pkill -KILL -f '${pattern}'; kill -KILL $(tagged)`)} } 2>/dev/null; sleep 1`,
    `if alive; then echo alive; exit 1; else echo killed; fi`,
  ].join("\n");
};

/** Prints `pgid <n>` from run `id`'s pgid file there, or `none` when it has none. */
export const remotePgidScript = (id: string) => {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe run id: ${id}`);
  return `p=$(cat "runs/${id}.pgid" 2>/dev/null); case "$p" in ''|*[!0-9]*|0|1) echo none ;; *) echo "pgid $p" ;; esac`;
};

export const INSTALL_FAILED = "Dependency install on Linux failed";

const PLAYWRIGHT_MISSING = /Executable doesn't exist at \S*ms-playwright/;
const withoutAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
/** A test runner's row (`✓ name`): it only quotes a failure. */
const TEST_ROW = /^\s*[✓↓×✗○❯→√]/;
/** A row of a test that passed, was skipped or runs: never a failure, of the run or an install. */
const GOOD_ROW = /^\s*[✓↓○❯→√]/;
/** `pattern` is in `line` outside a double-quoted string, which only quotes it. */
const saysUnquoted = (line: string, pattern: RegExp) => {
  const at = line.search(pattern);
  return at >= 0 && (line.slice(0, at).match(/(?<!\\)"/g)?.length ?? 0) % 2 === 0;
};

/** The command's own output says Playwright's browser is not installed there. */
export const browserMissing = (output: string) => {
  const line = withoutAnsi(output);
  return !TEST_ROW.test(line) && saysUnquoted(line, PLAYWRIGHT_MISSING);
};

// A package install or lazy download that was unfinished, or raced, when the run started there.
const INSTALL_FAILURES: ReadonlyArray<readonly [RegExp, string | null]> = [
  [/Electron failed to install correctly/, "electron"],
  [PLAYWRIGHT_MISSING, "playwright"],
  [/Could not find Chrom(?:e|ium) \(ver\./, "puppeteer"],
  [/Cypress (?:binary is missing|executable not found)/i, "cypress"],
  // Matched where the failure is named, so a quote around it shows.
  [/(?:\bEEXIST\b|File exists \(os error 17\))(?=.*node_modules\/)/, null],
  [/\S*node_modules\/\S*(?=.*(?:\bEEXIST\b|File exists \(os error 17\)))/, null],
];

/** The package an output line says is not installed yet there, else null. */
export const installFailure = (output: string): string | null => {
  const line = withoutAnsi(output);
  // Read before the command only: a `×` there is an installer's error (miette), not a test's.
  if (GOOD_ROW.test(line)) return null;
  const hit = INSTALL_FAILURES.find(([pattern]) => saysUnquoted(line, pattern));
  if (hit === undefined) return null;
  return (
    hit[1] ??
    /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/\s'"]+\/)?[^/\s'"]+)/.exec(
      line,
    )?.[1] ??
    "node_modules"
  );
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
