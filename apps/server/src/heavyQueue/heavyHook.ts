/**
 * The Claude Code PreToolUse hook that sends heavy Bash commands through the queue. Pure: the
 * `t3 heavy hook` CLI and the in-process SDK hook both call it, and anything unexpected leaves the
 * command untouched.
 */
import { parseLine, type Command, type ParsedLine, type Word } from "./shellLine.ts";

/** Claude Code's ceiling for a foreground Bash call; a higher request is capped, not rejected. */
const BASH_MAX_TIMEOUT_MS = 600_000;
/** Set in a queue job's environment: commands inside it already hold a slot. */
export const HEAVY_JOB_ENV = "T3CODE_HEAVY_JOB";

// ponytail: known type checkers; add one here when a new checker shows up on the Mac.
export const TYPE_CHECKERS = [
  "tsc",
  "tsgo",
  "effect-tsgo",
  "vue-tsc",
  "svelte-check",
  "tsc-files",
  "pyright",
  "mypy",
];
const DIRECT = new Set([
  "vitest",
  "jest",
  "mocha",
  "playwright",
  ...TYPE_CHECKERS,
  "oxlint",
  "eslint",
  "knip",
  "xcodebuild",
  "gradle",
  "gradlew",
  "webpack",
  "rollup",
  "turbo",
  "nx",
  "pytest",
  "mvn",
  "emulator",
]);
const SUBCOMMANDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  docker: ["build", "buildx", "compose", "run"],
  cargo: ["build", "test", "check", "clippy", "run", "bench", "nextest"],
  go: ["test", "build", "vet"],
  swift: ["build", "test"],
  expo: ["run", "run:ios", "run:android", "prebuild", "export"],
  eas: ["build"],
  simctl: ["boot"],
};
/** Script names that run tests, builds or checks; dev servers stay out, they never finish. */
const SCRIPT_NAMES = [
  "test",
  "tests",
  "build",
  "check",
  "lint",
  "typecheck",
  "e2e",
  "bundle",
  "compile",
  "knip",
  "coverage",
  "fmt",
  "format",
  "ci",
  "verify",
];
const FORMAT_NAMES = ["fmt", "format"];
const SCRIPT = new RegExp(`^(${SCRIPT_NAMES.join("|")})([:._-].*)?$|^dev:desktop$`);
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "vp", "deno"]);
const EXECUTORS = new Set(["npx", "pnpx", "bunx"]);
const SCRIPT_RUNNERS = ["vpr", "make", "just"];

/** Every program `heavyWords` can call heavy but `node` and `git`: a queue job's PATH shims. */
export const SHIMMED = new Set([
  ...DIRECT,
  ...Object.keys(SUBCOMMANDS),
  ...RUNNERS,
  ...EXECUTORS,
  ...SCRIPT_RUNNERS,
]);
/**
 * For a shim's `case` filter, a superset of what `heavyWords` reads: programs always heavy, and
 * the words (script names take a `:`-style suffix) that can make another call heavy.
 */
export const SHIM_FILTER = {
  always: [...DIRECT],
  words: [...DIRECT, ...Object.values(SUBCOMMANDS).flat(), "t", "dev:desktop"],
  scripts: SCRIPT_NAMES.filter((name) => !FORMAT_NAMES.includes(name)),
  formats: FORMAT_NAMES,
};
const PREFIXES = new Set([
  "time",
  "nice",
  "env",
  "command",
  "exec",
  "caffeinate",
  "timeout",
  "nohup",
  "eval",
]);

const base = (word: string) => word.split("/").pop() ?? word;
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
/**
 * Run here around the remote part: `time vp test` times the whole Linux run. Each must stay in
 * the job's process group, so a part Linux never ran can end the line (`timeout` does not).
 */
const LOCAL_PREFIXES = new Set(["time", "nice", "command", "exec", "caffeinate", "nohup"]);

/** A prefix's options that take the next word as their value (`timeout -s KILL`, `env -u NAME`). */
const PREFIX_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  nice: new Set(["-n", "--adjustment"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  exec: new Set(["-a"]),
  caffeinate: new Set(["-t", "-w"]),
};

/** Where a command's program starts, past assignments, prefixes and their options (`nice -n 5`). */
const programAt = (values: ReadonlyArray<string>, from = 0, local = false) => {
  let at = from;
  while (at < values.length) {
    const word = base(values[at]!);
    if (!(local ? LOCAL_PREFIXES : PREFIXES).has(word)) break;
    at++;
    while (at < values.length) {
      const value = values[at]!;
      if (PREFIX_VALUE_OPTIONS[word]?.has(value)) at += 2;
      else if (/^-|^\d+(\.\d+)?[smhd]?$/.test(value) || isAssignment(value)) at++;
      else break;
    }
  }
  return at;
};

/** Git's own options before its subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
]);

/**
 * Where git's subcommand sits past git's own options (`git -c k=v -C dir commit`), and the folders
 * its `-C` options move to, in order. `at` is the word of the program itself.
 */
export const gitCommand = (values: ReadonlyArray<string>, at: number) => {
  let sub = at + 1;
  const dirs: string[] = [];
  while (sub < values.length && values[sub]!.startsWith("-")) {
    if (!GIT_VALUE_OPTIONS.has(values[sub]!)) {
      sub += 1;
      continue;
    }
    if (values[sub] === "-C" && values[sub + 1] !== undefined) dirs.push(values[sub + 1]!);
    sub += 2;
  }
  return { sub, dirs };
};

/** Options that name the folder a program works in (`pnpm -C <dir>`), by program. */
// ponytail: these tools only; add one when another's folder flag shows up.
export const FOLDER_FLAGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  pnpm: ["-C", "--dir"],
  npm: ["-C", "--prefix"],
  yarn: ["--cwd"],
  bun: ["--cwd"],
  make: ["-C", "--directory"],
};

/** Program and subcommand words with assignments, prefixes, flags and folder values removed. */
const wordsAt = (values: ReadonlyArray<string>, from: number) => {
  const at = programAt(values, from);
  const program = values[at] === undefined ? "" : base(values[at]!);
  const rest = values.slice(program === "git" ? gitCommand(values, at).sub : at + 1);
  const folderFlags = FOLDER_FLAGS[program] ?? [];
  return {
    at,
    program,
    words: rest.filter(
      (value, index) => !value.startsWith("-") && !folderFlags.includes(rest[index - 1] ?? ""),
    ),
    flags: rest.filter((value) => value.startsWith("-")),
  };
};

const FORMAT = new RegExp(`^(${FORMAT_NAMES.join("|")})([:._-].*)?$`);
// ponytail: source files only; a folder with a dot (`apps/v1.2`) must not pass. Add one when needed.
const FILE_ARG =
  /(^|\/)[^/]*[^/.]\.(ts|tsx|js|mjs|cjs|jsx|json|jsonc|md|mdx|css|scss|html|yml|yaml|toml|vue|svelte)$/;
/** A file named as written: no expansion or substitution can make it a folder or a whole tree. */
const isFile = (value: string) => !/[$`]/.test(value) && FILE_ARG.test(value);

/**
 * Expansions the line itself shows to list files: a `for` variable over file names, or an array
 * of them (`f=(a.ts b.ts)` then `"${f[@]}"`), each set once. Any other expansion may be a tree.
 */
const fileListsOf = ({ commands, loops }: ParsedLine): ReadonlySet<string> => {
  const sets = new Map<string, boolean[]>();
  const add = (name: string, files: boolean) => sets.set(name, [...(sets.get(name) ?? []), files]);
  for (const [name, items] of loops) {
    add(name, items !== null && items.length > 0 && items.every((item) => isFile(item.value)));
  }
  for (const word of commands.flatMap((command) => command.assigns)) {
    const [, name, op, array] = /^([A-Za-z_]\w*)(\+?=)(?:\((.*)\)$)?/su.exec(word.value) ?? [];
    if (name === undefined) continue;
    const items = array?.trim().split(/\s+/u) ?? [];
    add(name, op === "=" && items.length > 0 && items.every(isFile));
  }
  return new Set(
    [...sets].flatMap(([name, files]) =>
      files.length === 1 && files[0]
        ? loops.has(name)
          ? [`$${name}`, `\${${name}}`]
          : [`\${${name}[@]}`]
        : [],
    ),
  );
};

/**
 * Whether the script `words[at]` names is heavy. A formatter given its files one by one (or one
 * file on stdin) touches only those, so it is light; without them it walks the whole tree.
 */
const heavyScript = (
  words: ReadonlyArray<string>,
  at: number,
  flags: ReadonlyArray<string>,
  lists: ReadonlySet<string>,
) => {
  const script = words[at];
  if (script === undefined || !SCRIPT.test(script)) return false;
  if (!FORMAT.test(script)) return true;
  const files = words.slice(at + 1);
  const stdin = flags.some((flag) => /^--stdin-file-?path(=|$)/.test(flag));
  return !(stdin || (files.length > 0 && files.every((file) => isFile(file) || lists.has(file))));
};

const heavyWords = (
  program: string,
  words: ReadonlyArray<string>,
  flags: ReadonlyArray<string>,
  lists: ReadonlySet<string>,
): boolean => {
  const [first, second] = words;
  if (DIRECT.has(program)) return true;
  const sub = SUBCOMMANDS[program];
  if (sub !== undefined) return first !== undefined && sub.includes(first);
  if (program === "xcrun" || EXECUTORS.has(program)) {
    return first !== undefined && heavyWords(base(first), words.slice(1), flags, lists);
  }
  if (program === "node") return flags.some((flag) => /^--test(=|$)/.test(flag));
  if (program === "git") {
    return first === "commit" && !flags.some((flag) => flag === "--no-verify" || flag === "-n");
  }
  if (SCRIPT_RUNNERS.includes(program)) {
    return heavyScript(words, 0, flags, lists);
  }
  if (!RUNNERS.has(program) || first === undefined) return false;
  if (first === "exec" || first === "dlx" || first === "x") {
    return second !== undefined && heavyWords(base(second), words.slice(2), flags, lists);
  }
  // `vp test`, `npm test`, `yarn build`: package managers run these scripts by name.
  if (first === "t" || heavyScript(words, 0, flags, lists)) return true;
  // `pnpm --filter web run build`: a flag's value can sit before `run`.
  const runAt = words.findIndex((word) => word === "run" || word === "run-script");
  return runAt >= 0 && heavyScript(words, runAt + 1, flags, lists);
};

// `case` patterns, so the filter runs on shell builtins alone. A word starts after a non-name
// character or a JSON escape (the hook reads raw JSON), and ends before a non-name character.
const STARTS = [
  "[!A-Za-z0-9_.-]",
  String.raw`\\[nrtbf]`,
  String.raw`\\u[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]`,
];
const END = "[!A-Za-z0-9_-]";
// `remoto` too: with the Runner on, the hook takes over an agent's own `remoto` call.
const PROGRAMS = [
  ...DIRECT,
  ...Object.keys(SUBCOMMANDS),
  ...RUNNERS,
  ...SCRIPT_RUNNERS,
  "remoto",
  // An agent's own `ssh` to the Runner's host: T3 knows the host.
  "ssh",
  // Scripts: the queue reads them (`bash x.sh`, `./verify`).
  "sh",
  "bash",
  "zsh",
  "dash",
];

/**
 * Matches every command `heavySegment` calls heavy, and some it does not: any program heavy work
 * can start from. Built from the same sets, so the two never drift.
 */
const HEAVY_PREFILTER = STARTS.flatMap((start) => [
  ...PROGRAMS.map((program) => `*${start}${program}${END}*`),
  `*${start}git${END}*commit*`,
  `*${start}node${END}*--test*`,
  `*${start}./*`,
])
  .concat([`*.sh${END}*`, "*.sh"])
  .join("|");

/**
 * The `sh` entry Claude Code runs for sessions outside T3. Light commands answer here without
 * starting another process; only ones that may be heavy pay for `hookCommand`. Every failure,
 * a missing T3 included, exits 0 with no output, which leaves the command as it was.
 */
export const hookScript = (hookCommand: string) => `#!/bin/sh
# Written by T3 Code for its Claude Code hook (Settings > Maintenance > Heavy work).
# Read the input first even when leaving: a writer racing an early exit gets EPIPE.
[ "\${${HEAVY_JOB_ENV}:-}" = 1 ] && { cat >/dev/null; exit 0; }
input=
while IFS= read -r line || [ -n "$line" ]; do input="$input$line
"; done
# Just the command's JSON text: \`","\` never occurs inside an escaped string, so it ends it.
rest=\${input#*\\"command\\"}
case "\${rest%%\\",\\"*}" in
  ${HEAVY_PREFILTER}) ;;
  *) exit 0 ;;
esac
# Only a complete answer goes back; a T3 that fails halfway says nothing.
answer=$(printf '%s' "$input" | { ${hookCommand}; } 2>/dev/null) || exit 0
printf '%s' "$answer"
`;

/** One simple command of a line, as the queue and the Runner see it. */
export interface Part {
  readonly command: Command;
  readonly values: ReadonlyArray<string>;
  /** The word the work starts at: past local prefixes (`time`) and an agent's `remoto`. */
  readonly remoteAt: number;
  /** The program's word, past `env` and its assignments. */
  readonly programAt: number;
  readonly program: string;
  readonly words: ReadonlyArray<string>;
  readonly flags: ReadonlyArray<string>;
  readonly heavy: boolean;
  /** The agent's own `remoto` in front of it. */
  readonly remoto: Word | null;
  /**
   * Its nested `sh -c` line or its script hands work off itself, to `remoto` or `t3 heavy`: T3
   * never wraps it in another `remoto`, and Linux, which has no `t3`, never runs it.
   */
  readonly handsOffInside: boolean;
  /**
   * All its heavy work goes through `remoto` or `t3 heavy`, its own or inside it: nothing of it
   * holds this Mac.
   */
  readonly remote: boolean;
  /** It is `t3 heavy …`, or the T3 executable's `heavy` subcommand as `selfPrefix` writes it. */
  readonly queued: boolean;
  /** The heavy part inside a nested `sh -c '<line>'`, which makes this part heavy too. */
  readonly nested: Part | null;
  /** The shell script it runs, by its path word, and its text (null when it couldn't be read). */
  readonly script: { readonly word: string; readonly body: string | null } | null;
}

/** A script's text, or null when it is missing, unreadable or over `SCRIPT_MAX_BYTES`. */
export type ReadScript = (word: string) => string | null;
export const SCRIPT_MAX_BYTES = 64 * 1024;
const SHEBANG = /^#!\s*(\S*\/)?(env\s+)?(sh|bash|zsh|dash)(\s|$)/;

/** The path word of the script a command runs: `bash x.sh`, `./x.sh`, or any path (`./verify`). */
const scriptWord = (values: ReadonlyArray<string>, at: number): string | null => {
  const program = values[at];
  if (program === undefined || program === "") return null;
  if (SHELLS.has(base(program))) {
    const rest = values.slice(at + 1);
    if (rest.some((value) => /^-[a-z]*[cs][a-z]*$/.test(value))) return null;
    return rest.find((value) => !value.startsWith("-")) ?? null;
  }
  // A package's bin (`node_modules/.bin/vp`) is a launcher: the program it starts decides.
  if (/(^|\/)node_modules\//.test(program)) return null;
  return program.endsWith(".sh") || program.includes("/") ? program : null;
};

/** What the script word names: a script for sure (`.sh`, run by a shell) or by its shebang. */
export const scriptOf = (
  values: ReadonlyArray<string>,
  at: number,
  read: ReadScript | undefined,
) => {
  const word = read === undefined ? null : scriptWord(values, at);
  if (word === null) return null;
  const body = read!(word);
  const sure = SHELLS.has(base(values[at]!)) || word.endsWith(".sh");
  if (body !== null && (sure || SHEBANG.test(body))) return { word, body };
  return sure && body === null ? { word, body: null } : null;
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** `bash -c '<line>'`: the line's parts, its scripts read like the line's own. */
const nestedParts = (
  program: string,
  values: ReadonlyArray<string>,
  at: number,
  read: ReadScript | undefined,
) => {
  if (!SHELLS.has(program)) return [];
  const flag = values.findIndex((value, index) => index > at && /^-[a-z]*c[a-z]*$/.test(value));
  const line = flag < 0 ? undefined : values[flag + 1];
  return line === undefined ? [] : readLine(line, read).parts;
};

const handsOff = (part: Part) => part.remoto !== null || part.queued || part.handsOffInside;

const isHeavyCall = (values: ReadonlyArray<string>) => {
  let at = 1;
  while (at < values.length && /\.[cm]?js$/.test(values[at]!)) at++;
  const next = values[at + 1] ?? "";
  return (
    values[at] === "heavy" &&
    (base(values[0] ?? "") === "t3" || next === "hook" || next.startsWith("--"))
  );
};

const partOf = (command: Command, lists: ReadonlySet<string>, read?: ReadScript): Part => {
  const values = command.words.map((word) => word.value);
  let remoteAt = programAt(values, 0, true);
  let remoto: Word | null = null;
  if (base(values[remoteAt] ?? "") === "remoto" && remoteAt + 1 < values.length) {
    remoto = command.words[remoteAt]!;
    remoteAt = programAt(values, remoteAt + 1, true);
  }
  const { at, program, words, flags } = wordsAt(values, remoteAt);
  const inner = nestedParts(program, values, at, read);
  const nested = inner.find((part) => part.heavy) ?? null;
  const script = scriptOf(values, at, read);
  // A script's own scripts are not followed: one level is what an agent's scratch script needs.
  const unreadable = script !== null && script.body === null;
  const scriptParts = script?.body == null ? [] : readLine(script.body).parts;
  const scriptHeavy = scriptParts.some((part) => part.heavy);
  const insideParts = [...inner, ...scriptParts];
  const handsOffInside = insideParts.some(handsOff);
  const ownHeavy = unreadable || (program !== "" && heavyWords(program, words, flags, lists));
  return {
    command,
    values,
    remoteAt,
    programAt: at,
    program,
    words,
    flags,
    heavy: nested !== null || scriptHeavy || ownHeavy,
    remoto,
    handsOffInside,
    remote:
      remoto !== null ||
      (handsOffInside && !ownHeavy && insideParts.every((part) => !part.heavy || part.remote)),
    queued: isHeavyCall(values.slice(at)),
    nested,
    script,
  };
};

/** Every simple command of a line in source order, and why it cannot be followed exactly. */
export const readLine = (
  line: string,
  read?: ReadScript,
): { readonly unsafe: string | null; readonly parts: Part[] } => {
  const parsed = parseLine(line);
  const lists = fileListsOf(parsed);
  return {
    unsafe: parsed.unsafe,
    parts: parsed.commands
      .map((command) => partOf(command, lists, read))
      .toSorted((a, b) => a.command.start - b.command.start),
  };
};

const BUILTINS = new Set([
  "cd",
  "pushd",
  "popd",
  "export",
  "unset",
  "set",
  "source",
  ".",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "[[",
  ":",
  "exit",
  "return",
  "shift",
  "read",
  "wait",
  "trap",
  "local",
  "declare",
  "alias",
  "sleep",
]);

/**
 * The parts that are the work: heavy ones and `remoto` calls, else every program a queued job runs.
 * A part that hands work off inside itself (`remoto`, `t3 heavy`) is never work: Linux has no `t3`.
 */
export const workParts = (parts: ReadonlyArray<Part>) => {
  const own = parts.filter((part) => !part.handsOffInside);
  const work = own.filter((part) => part.heavy || part.remoto !== null);
  return work.length > 0
    ? work
    : own.filter((part) => part.program !== "" && !part.queued && !BUILTINS.has(part.program));
};

/** The `git commit` parts of a line whose only work is committing, or null for any other line. */
export const commitOnly = (line: string) => {
  const work = readLine(line).parts.filter((part) => part.heavy);
  const commits = work.every(
    (part) =>
      part.nested === null &&
      part.remoto === null &&
      part.program === "git" &&
      part.words[0] === "commit",
  );
  return work.length > 0 && commits ? work : null;
};

/** Every part of a shell command line that is heavy work, in order. */
const heavySegments = (command: string, read?: ReadScript): ReadonlyArray<string> =>
  readLine(command, read)
    .parts.filter((part) => part.heavy)
    .map((part) => command.slice(part.command.start, part.command.end).trim());

/** The first part of a shell command line that is heavy work, or null when none is. */
export const heavySegment = (command: string, read?: ReadScript): string | null =>
  heavySegments(command, read)[0] ?? null;

/** ssh options that take a value: `-p 22`, or glued on as `-p22`. */
const SSH_VALUE_OPTIONS = new Set("BbcDEeFIiJLlmOoPpQRSWw");

/** The index past ssh options (and a `--`) from `index`; ssh reads them after the host too. */
const pastSshOptions = (values: ReadonlyArray<string>, index: number) => {
  while (index < values.length) {
    const value = values[index]!;
    if (value === "--") return index + 1;
    if (!value.startsWith("-") || value === "-") break;
    const letters = value.slice(1).split("");
    const valueAt = letters.findIndex((letter) => SSH_VALUE_OPTIONS.has(letter));
    index += valueAt === letters.length - 1 ? 2 : 1;
  }
  return index;
};

/** `ssh [options] <host> <command…>` as its host and the line the remote shell runs; null for a login. */
const sshCall = (values: ReadonlyArray<string>, at: number) => {
  if (base(values[at] ?? "") !== "ssh") return null;
  const index = pastSshOptions(values, at + 1);
  const target = values[index];
  const rest = values.slice(pastSshOptions(values, index + 1));
  return target === undefined || rest.length === 0 ? null : { target, line: rest.join(" ") };
};

const hostOf = (target: string) => target.slice(target.lastIndexOf("@") + 1).toLowerCase();

/** Resolves a host as ssh would (`sshHostname`); null when it can't, so names compare as written. */
export type ResolveHost = (host: string) => string | null;

/**
 * The heavy part of work a line sends to `host` over its own ssh, or null when none: ssh skips
 * the queue and the Linux copy, so the Runner takes it as a Linux job. A remote script can't be
 * read from here, so like an unread one here only a known heavy command queues.
 */
export const sshWork = (
  line: string,
  host: string,
  resolve: ResolveHost = () => null,
): string | null => {
  const runner = hostOf(host);
  if (runner.trim() === "") return null;
  const same = (target: string) => {
    const name = hostOf(target);
    if (name === runner) return true;
    const resolved = resolve(name);
    return resolved !== null && resolved === resolve(runner);
  };
  for (const part of readLine(line).parts) {
    const call = sshCall(part.values, part.programAt);
    // Heavy first: only heavy work to another name pays for resolving it.
    const heavy = call === null ? null : heavySegment(call.line);
    if (heavy !== null && same(call!.target)) return heavy;
  }
  return null;
};

/**
 * The line runs `t3 heavy` itself (the prefix agents copy from `t3_heavy` status) or `remoto`,
 * which already runs work on another machine, and no heavy part runs outside them. Quoted text
 * and a grep pattern are arguments, never a call.
 */
export const isQueued = (command: string, read?: ReadScript) => {
  const { parts } = readLine(command, read);
  return (
    parts.some((part) => part.queued || part.remote) &&
    parts.every((part) => !part.heavy || part.remote)
  );
};

/** A `cd` argument as the folder it names (`~` unexpanded), or null when only the shell could tell. */
const literalDir = (word: Word | undefined): string | null => {
  if (word === undefined || word.vars.length > 0) return null;
  const { value } = word;
  if (value === "" || value.startsWith("-") || /[*?[]/.test(value)) return null;
  // Quoted, `~` is a folder named `~`; `~user` is another home.
  if (value.startsWith("~") && (!word.tilde || !/^~(\/|$)/.test(value))) return null;
  return value;
};

const spanEnd = (line: string, end: number) => {
  let at = end;
  while (line[at] === " " || line[at] === "\t") at++;
  return at;
};

/** The line without an agent's `remoto` words: T3 decides where work runs. */
const withoutRemoto = (line: string) =>
  readLine(line)
    .parts.flatMap((part) => (part.remoto === null ? [] : [part.remoto]))
    .toSorted((a, b) => b.start - a.start)
    .reduce((text, word) => text.slice(0, word.start) + text.slice(spanEnd(line, word.end)), line);

/**
 * A shell line as `[cd <dir> && …] <command>`: the folders its leading `cd`s name, in order (`~`
 * unexpanded), whether an agent's `remoto` runs in it, and the rest with `remoto` taken out.
 * Parsing stops at the first `cd` it cannot resolve, which stays in `command`.
 */
export const lineParts = (line: string) => {
  const { parts } = readLine(line);
  const dirs: string[] = [];
  let from = 0;
  for (const part of parts) {
    const { command } = part;
    const dir = literalDir(command.words[1]);
    if (
      command.scope.length > 0 ||
      command.substituted ||
      command.next !== "&&" ||
      command.assigns.length > 0 ||
      command.redirects.length > 0 ||
      part.values[0] !== "cd" ||
      part.values.length !== 2 ||
      dir === null
    ) {
      break;
    }
    dirs.push(dir);
    from = line.indexOf("&&", command.end) + 2;
  }
  return {
    dirs,
    remoto: parts.some((part) => part.remoto !== null),
    command: withoutRemoto(line.slice(from)).trimStart(),
  };
};

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A short title for the queue row: the heavy part's program and first words. */
export const nameOf = (segment: string) => {
  const { parts } = readLine(segment);
  const found = parts.find((each) => each.heavy) ?? parts.find((each) => each.program !== "");
  if (found === undefined) return segment.trim().slice(0, 60);
  const part = found.nested ?? found;
  // `git commit -m "…"`: the message is not part of the name.
  return [part.program, ...part.words.slice(0, part.program === "git" ? 1 : 2)]
    .join(" ")
    .slice(0, 60);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The PreToolUse answer for a Bash call, or null to leave it alone. `queuePrefix` is the
 * invocation up to and including `heavy --queue-dir <dir>`.
 */
export const queueBashCall = (
  hookInput: unknown,
  queuePrefix: string,
  environment: Readonly<Record<string, string | undefined>> = {},
  options: {
    /** The Runner is on: an agent's `remoto <cmd>` is queued too, and `t3 heavy` sends it to Linux once. */
    readonly runner?: boolean;
    /** Reads a script the line runs, from the folder the line starts in. */
    readonly readScript?: ReadScript;
    /** The Runner's Linux: heavy work sent there by `ssh` is queued for it. */
    readonly runnerHost?: string;
    readonly resolveHost?: ResolveHost;
  } = {},
) => {
  if (environment[HEAVY_JOB_ENV] === "1" || !isRecord(hookInput)) return null;
  if (hookInput.tool_name !== "Bash" || !isRecord(hookInput.tool_input)) return null;
  const toolInput = hookInput.tool_input;
  const command = toolInput.command;
  if (typeof command !== "string") return null;
  const parts = lineParts(command);
  const ssh =
    options.runner === true && options.runnerHost !== undefined
      ? sshWork(command, options.runnerHost, options.resolveHost)
      : null;
  const remoto = options.runner === true && parts.remoto;
  if (ssh === null && !remoto && isQueued(command, options.readScript)) return null;
  const segment =
    ssh ??
    (remoto
      ? (heavySegment(parts.command, options.readScript) ?? parts.command.trim())
      : heavySegment(command, options.readScript));
  if (segment === null) return null;
  const currentTimeout = typeof toolInput.timeout === "number" ? toolInput.timeout : 0;
  // A repeat of the same call attaches to its job instead of running it twice.
  const request =
    typeof hookInput.tool_use_id === "string" && hookInput.tool_use_id !== ""
      ? ` --request-id ${shellQuote(hookInput.tool_use_id)}`
      : "";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      // Replaces the whole input, so every field Claude sent stays.
      updatedInput: {
        ...toolInput,
        command: `${queuePrefix}${request}${ssh === null ? "" : " --runner linux"} --name ${shellQuote(nameOf(segment))} -- "\${SHELL:-/bin/sh}" -c ${shellQuote(command)}`,
        // Waiting counts toward the Bash timeout; a background call keeps its own, longer limit.
        ...(toolInput.run_in_background === true
          ? {}
          : { timeout: Math.max(currentTimeout, BASH_MAX_TIMEOUT_MS) }),
      },
    },
  };
};

/**
 * How heavy work runs right now: through `t3 heavy`, or started as written. The one switch every
 * entry point reads: the in-process Claude hook and `t3 heavy hook` through `interceptBashCall`,
 * `t3 heavy` itself, and admission's `plan` (which passes no `runner`, so it gates on the queue
 * alone). Queue and Runner switch independently; work goes through while either is on.
 */
export type HeavyRoute = "queue" | "direct";
export const heavyRoute = (mode: {
  readonly enabled: boolean;
  readonly runner?: boolean;
}): HeavyRoute => (mode.enabled || mode.runner === true ? "queue" : "direct");

/** The hook's answer for these switches; null leaves the call as Claude wrote it. */
export const interceptBashCall = (
  hookInput: unknown,
  queuePrefix: string,
  mode: { readonly enabled: boolean; readonly runner?: boolean; readonly runnerHost?: string },
  environment: Readonly<Record<string, string | undefined>> = {},
  readScript?: ReadScript,
  resolveHost?: ResolveHost,
) =>
  heavyRoute(mode) === "direct"
    ? null
    : queueBashCall(hookInput, queuePrefix, environment, {
        runner: mode.runner === true,
        ...(mode.runnerHost === undefined ? {} : { runnerHost: mode.runnerHost }),
        ...(readScript === undefined ? {} : { readScript }),
        ...(resolveHost === undefined ? {} : { resolveHost }),
      });

export type BashHook = (hookInput: unknown) => ReturnType<typeof queueBashCall>;
