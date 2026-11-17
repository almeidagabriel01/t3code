/**
 * Command shapes the Runner, admission and the cost class share. A leaf: it imports nothing from
 * the queue, so `runner.ts`, `admission.ts` and `costClass.ts` all read it without a cycle.
 */
import type { HeavyQueueEntry } from "@t3tools/contracts";

export const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "vp", "deno"]);
const DEV_SERVER = /^(dev|start|serve|watch|preview)([:._-].*)?$|(^|[:._-])watch([:._-]|$)/;
/** Options that pick a workspace package (`pnpm --filter web dev`): their value is no script. */
const SELECTOR_FLAGS = new Set(["--filter", "-F", "--workspace"]);
const RUN = /^(run|run-script)$/;
const DEV_PROGRAMS: Readonly<Record<string, RegExp>> = {
  vite: /^(dev|serve|preview)?$/,
  next: /^(dev|start)$/,
  expo: /^start$/,
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

/** A dev server by its script or program (`vp run dev`, `next dev`, `expo start`). */
export const isDevServer = (
  program: string,
  words: ReadonlyArray<string>,
  flags: ReadonlyArray<string> = [],
) => {
  const target = runTarget(program, words);
  const selected = PACKAGE_MANAGERS.has(target.program) && flags.some((f) => SELECTOR_FLAGS.has(f));
  // The selector's value is the first word that is not `run`, wherever the selector sits.
  const value = selected ? target.words.findIndex((word) => !RUN.test(word)) : -1;
  const [first = "", second = ""] = target.words.filter((_, index) => index !== value);
  // A program can be named like an object key (`__proto__`): only the table's own entries count.
  if (Object.hasOwn(DEV_PROGRAMS, target.program) && DEV_PROGRAMS[target.program]!.test(first)) {
    return true;
  }
  if (!PACKAGE_MANAGERS.has(target.program)) return false;
  return DEV_SERVER.test(RUN.test(first) ? second : first);
};

/** Never finishes by itself: a dev server or a watcher (`--watch`, `vitest watch`). */
export const keepsRunning = (
  program: string,
  words: ReadonlyArray<string>,
  flags: ReadonlyArray<string>,
) =>
  isDevServer(program, words, flags) ||
  flags.some((flag) => /^--watch(=(?!false$|0$)|$)/.test(flag)) ||
  runTarget(program, words).words.includes("watch");

export type Kind = "exclusive" | "heavy" | "medium";

const EXCLUSIVE = /simulator|emulator|simctl|\bavd\b|expo run|dev app/i;
const HEAVY = /\b(build|bundle|e2e|playwright|browser|docker|cargo|gradle|xcodebuild|compile)\b/i;
const MEDIUM = /\b(typecheck|tsc|lint|oxlint|fmt|format|check|check:changed)\b/i;
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
  if (HEAVY.test(line)) return "heavy";
  if (MEDIUM.test(line) || (/\btest\b/.test(line) && FILE_ARG.test(line))) {
    return "medium";
  }
  return "heavy";
};
