/**
 * Command shapes the Runner, admission and the cost class share. A leaf: it imports nothing from
 * the queue, so `runner.ts`, `admission.ts` and `costClass.ts` all read it without a cycle.
 */
import type { HeavyQueueEntry } from "@t3tools/contracts";

export const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "vp", "deno"]);
/** Options that pick a workspace package (`pnpm --filter web dev`): their value is no script. */
const SELECTOR_FLAGS = new Set(["--filter", "-F", "--filter-prod", "--workspace"]);
const RUN = /^(run|run-script)$/;
const DEV_WORD = /^(dev|start|serve|preview|storybook)$/;
/** A finite step a script's name may also name: `serve-static-build` builds and ends. */
const FINITE_STEP = /^(build|test|lint|check|typecheck|e2e|ci|bundle|compile|export|generate)$/;
/**
 * A script or task that never ends: a watch segment anywhere in its name watches; a server word
 * leading it with no finite step after serves.
 */
export const scriptCode = (name: string): "watches" | "serves-port" | null => {
  const [head = "", ...rest] = name.split(/[:._-]/);
  if (head === "watch" || rest.includes("watch")) return "watches";
  const serves = DEV_WORD.test(head) && !rest.some((each) => FINITE_STEP.test(each));
  return serves ? "serves-port" : null;
};
export const DEV_PROGRAMS: Readonly<Record<string, RegExp>> = {
  vite: /^(dev|serve|preview)?$/,
  next: /^(dev|start)$/,
  expo: /^start$/,
  wrangler: /^dev$/,
  storybook: /^(dev)?$/,
  "start-storybook": /^/,
  "react-native": /^start$/,
  metro: /^(serve|start)?$/,
};
export const EXECUTORS = new Set(["npx", "pnpx", "bunx"]);
const EXEC = /^(exec|dlx|x)$/;

/** `npx vite`, `pnpm exec next dev`: the tool they run, and its words. */
export const runTarget = (
  program: string,
  words: ReadonlyArray<string>,
): { readonly program: string; readonly words: ReadonlyArray<string> } => {
  if (!EXECUTORS.has(program) && !(PACKAGE_MANAGERS.has(program) && EXEC.test(words[0] ?? ""))) {
    return { program, words };
  }
  const at = EXECUTORS.has(program) ? 0 : 1;
  return { program: words[at]?.split("/").pop() ?? "", words: words.slice(at + 1) };
};

/**
 * Whether `rest[index]` is the value of a package pick (`pnpm test --filter web`, `-F a -F b`):
 * it names a package, never the script, wherever the selector sits.
 */
export const isPickValue = (program: string, rest: ReadonlyArray<string>, index: number) =>
  PACKAGE_MANAGERS.has(program) && SELECTOR_FLAGS.has(rest[index - 1] ?? "");

/** A dev server by its script or program (`vp run dev`, `next dev`, `expo start`). */
const isDevServer = (program: string, words: ReadonlyArray<string>) => {
  const target = runTarget(program, words);
  const [first = "", second = ""] = target.words;
  // A program can be named like an object key (`__proto__`): only the table's own entries count.
  if (Object.hasOwn(DEV_PROGRAMS, target.program) && DEV_PROGRAMS[target.program]!.test(first)) {
    return true;
  }
  if (!PACKAGE_MANAGERS.has(target.program)) return false;
  return scriptCode(RUN.test(first) ? second : first) !== null;
};

/**
 * `vitest watch`, `vp test watch`, `docker compose watch`: `watch` as the subcommand. Later it is
 * an argument, such as a test filter (`vitest run watch`).
 */
const watchesBySubcommand = ([first, second]: ReadonlyArray<string>) =>
  first === "watch" || (second === "watch" && (first === "test" || first === "compose"));

/** Never finishes by itself: a dev server or a watcher (`--watch`, `vitest watch`). */
export const keepsRunning = (
  program: string,
  words: ReadonlyArray<string>,
  flags: ReadonlyArray<string>,
) =>
  isDevServer(program, words) ||
  flags.some((flag) => /^--watch(=(?!false$|0$)|$)/.test(flag)) ||
  watchesBySubcommand(runTarget(program, words).words);

export type Kind = "exclusive" | "heavy" | "medium";

const EXCLUSIVE = /simulator|emulator|simctl|\bavd\b|expo run|dev app/i;
const HEAVY = /\b(build|bundle|e2e|playwright|browser|docker|cargo|gradle|xcodebuild|compile)\b/i;
const MEDIUM = /\b(typecheck|tsc|lint|oxlint|fmt|format|check|check:changed)\b/i;
/** The folders of a word naming a file (`a/b/x.ts` keeps `x.ts`). */
const FILE_FOLDERS = /(?<=^|[\s=])(?:[^\s/]*\/)+(?=[^\s/]+\.\w+(?=\s|$))/g;
const FILE_ARG = /\S+\.(test|spec)\.\w+|\S+\.(ts|tsx|js|jsx|mjs)\b/;

/**
 * Server-held entries are device opens; unknown commands count as heavy. Judged from the full
 * command line: the label is cut short for the row.
 */
export const kindOf = (
  entry: Pick<HeavyQueueEntry, "label" | "server"> & { readonly line?: string },
): Kind => {
  const line = entry.line ?? entry.label;
  if (entry.server === true || EXCLUSIVE.test(line)) return "exclusive";
  // A file is judged by its own name: `src/build/x.ts` builds nothing.
  const named = line.replace(FILE_FOLDERS, "");
  if (HEAVY.test(named)) return "heavy";
  if (MEDIUM.test(named) || (/\btest\b/.test(named) && FILE_ARG.test(line))) {
    return "medium";
  }
  return "heavy";
};
