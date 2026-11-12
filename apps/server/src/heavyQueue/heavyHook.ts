/**
 * The Claude Code PreToolUse hook that sends heavy Bash commands through the queue. Pure: the
 * `t3 heavy hook` CLI and the in-process SDK hook both call it, and anything unexpected leaves the
 * command untouched.
 */

/** Claude Code's ceiling for a foreground Bash call; a higher request is capped, not rejected. */
const BASH_MAX_TIMEOUT_MS = 600_000;
/** Set in a queue job's environment: commands inside it already hold a slot. */
export const HEAVY_JOB_ENV = "T3CODE_HEAVY_JOB";

const DIRECT = new Set([
  "vitest",
  "jest",
  "mocha",
  "playwright",
  "tsc",
  "tsgo",
  "effect-tsgo",
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
const SUBCOMMANDS: Readonly<Record<string, RegExp>> = {
  docker: /^(build|buildx|compose|run)$/,
  cargo: /^(build|test|check|clippy|run|bench|nextest)$/,
  go: /^(test|build|vet)$/,
  swift: /^(build|test)$/,
  expo: /^(run(:ios|:android)?|prebuild|export)$/,
  eas: /^build$/,
  simctl: /^boot$/,
};
/** Script names that run tests, builds or checks; dev servers stay out, they never finish. */
const SCRIPT =
  /^(test|tests|build|check|lint|typecheck|e2e|bundle|compile|knip|coverage|fmt|format|ci|verify)([:._-].*)?$|^dev:desktop$/;
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "vp", "deno"]);
const EXECUTORS = new Set(["npx", "pnpx", "bunx"]);
const PREFIXES = new Set(["time", "nice", "env", "command", "exec", "caffeinate"]);

const base = (word: string) => word.split("/").pop() ?? word;
const unquote = (word: string) => word.replace(/^['"]|['"]$/g, "");

/** Program and subcommand words with assignments, wrappers and flags removed. */
const wordsOf = (segment: string) => {
  // A quoted word stays one token: `NODE_OPTIONS="--max-old-space-size=4096" vp test`.
  const tokens = (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(unquote);
  while (
    tokens.length > 0 &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!) || PREFIXES.has(base(tokens[0]!)))
  ) {
    tokens.shift();
  }
  return {
    program: tokens[0] === undefined ? "" : base(tokens[0]),
    words: tokens.slice(1).filter((token) => !token.startsWith("-")),
    flags: tokens.slice(1).filter((token) => token.startsWith("-")),
  };
};

const heavyWords = (
  program: string,
  words: ReadonlyArray<string>,
  flags: ReadonlyArray<string>,
): boolean => {
  const [first, second] = words;
  if (DIRECT.has(program)) return true;
  const sub = SUBCOMMANDS[program];
  if (sub !== undefined) return first !== undefined && sub.test(first);
  if (program === "xcrun" || EXECUTORS.has(program)) {
    return first !== undefined && heavyWords(base(first), words.slice(1), flags);
  }
  if (program === "node") return flags.some((flag) => /^--test(=|$)/.test(flag));
  if (program === "git") {
    return first === "commit" && !flags.some((flag) => flag === "--no-verify" || flag === "-n");
  }
  if (program === "vpr" || program === "make" || program === "just") {
    return first !== undefined && SCRIPT.test(first);
  }
  if (!RUNNERS.has(program) || first === undefined) return false;
  if (first === "exec" || first === "dlx" || first === "x") {
    return second !== undefined && heavyWords(base(second), words.slice(2), flags);
  }
  // `vp test`, `npm test`, `yarn build`: package managers run these scripts by name.
  if (first === "t" || SCRIPT.test(first)) return true;
  // `pnpm --filter web run build`: a flag's value can sit before `run`.
  const runAt = words.findIndex((word) => word === "run" || word === "run-script");
  return runAt >= 0 && SCRIPT.test(words[runAt + 1] ?? "");
};

// `case` patterns, so the filter runs on shell builtins alone. A word starts after a non-name
// character or a JSON escape (the hook reads raw JSON), and ends before a non-name character.
const STARTS = [
  "[!A-Za-z0-9_.-]",
  String.raw`\\[nrtbf]`,
  String.raw`\\u[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]`,
];
const END = "[!A-Za-z0-9_-]";
const PROGRAMS = [...DIRECT, ...Object.keys(SUBCOMMANDS), ...RUNNERS, "vpr", "make", "just"];

/**
 * Matches every command `heavySegment` calls heavy, and some it does not: any program heavy work
 * can start from. Built from the same sets, so the two never drift.
 */
const HEAVY_PREFILTER = STARTS.flatMap((start) => [
  ...PROGRAMS.map((program) => `*${start}${program}${END}*`),
  `*${start}git${END}*commit*`,
  `*${start}node${END}*--test*`,
]).join("|");

/**
 * The `sh` entry Claude Code runs for sessions outside T3. Light commands answer here without
 * starting another process; only ones that may be heavy pay for `hookCommand`. Every failure,
 * a missing T3 included, exits 0 with no output, which leaves the command as it was.
 */
export const hookScript = (hookCommand: string) => `#!/bin/sh
# Written by T3 Code for its Claude Code hook (Settings > Maintenance > Heavy work).
[ "\${${HEAVY_JOB_ENV}:-}" = 1 ] && exit 0
input=
while IFS= read -r line || [ -n "\$line" ]; do input="\$input\$line
"; done
# Just the command's JSON text: \`","\` never occurs inside an escaped string, so it ends it.
rest=\${input#*\\"command\\"}
case "\${rest%%\\",\\"*}" in
  ${HEAVY_PREFILTER}) ;;
  *) exit 0 ;;
esac
# Only a complete answer goes back; a T3 that fails halfway says nothing.
answer=\$(printf '%s' "\$input" | { ${hookCommand}; } 2>/dev/null) || exit 0
printf '%s' "\$answer"
`;

/** The first part of a shell command line that is heavy work, or null when none is. */
export const heavySegment = (command: string): string | null => {
  for (const segment of command.split(/&&|\|\||[;|&\n()]/)) {
    const { program, words, flags } = wordsOf(segment);
    if (program !== "" && heavyWords(program, words, flags)) return segment.trim();
  }
  return null;
};

/**
 * `t3 heavy …`, the prefix agents copy from `t3_heavy` status (`'<exe>' heavy --queue-dir …`), or
 * `remoto …`, which already runs the command on another machine (or falls back here by itself).
 */
export const isQueued = (command: string) =>
  /^\s*(cd\s+\S+\s*&&\s*)?remoto(\s|$)/.test(command) ||
  /(^|[\s'"/])t3['"]?\s+heavy\b/.test(command) ||
  /\bheavy['"]?\s+--(queue-dir|name|priority)?(\s|=|$)/.test(command);

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A short title for the queue row: the heavy part's program and first words. */
export const nameOf = (segment: string) => {
  const { program, words } = wordsOf(segment);
  // `git commit -m "…"`: the message is not part of the name.
  return [program, ...words.slice(0, program === "git" ? 1 : 2)].join(" ").slice(0, 60);
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
) => {
  if (environment[HEAVY_JOB_ENV] === "1" || !isRecord(hookInput)) return null;
  if (hookInput.tool_name !== "Bash" || !isRecord(hookInput.tool_input)) return null;
  const toolInput = hookInput.tool_input;
  const { command } = toolInput;
  if (typeof command !== "string" || isQueued(command)) return null;
  const segment = heavySegment(command);
  if (segment === null) return null;
  const currentTimeout = typeof toolInput.timeout === "number" ? toolInput.timeout : 0;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      // Replaces the whole input, so every field Claude sent stays.
      updatedInput: {
        ...toolInput,
        command: `${queuePrefix} --name ${shellQuote(nameOf(segment))} -- "\${SHELL:-/bin/sh}" -c ${shellQuote(command)}`,
        // Waiting counts toward the Bash timeout; a background call keeps its own, longer limit.
        ...(toolInput.run_in_background === true
          ? {}
          : { timeout: Math.max(currentTimeout, BASH_MAX_TIMEOUT_MS) }),
      },
    },
  };
};

export type BashHook = (hookInput: unknown) => ReturnType<typeof queueBashCall>;
