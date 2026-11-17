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

const OP = /^(;;&|;;|;&|\n|[ \t\r]+|[;&|()<>])/;
const SEPARATORS = new Set([";", "&", "|", "(", "\n", ";;", ";&", ";;&"]);
const OPENERS = new Set(["then", "do", "else", "elif", "{", "!", "if", "while", "until"]);

/** One shell word at `at`, quotes, `$(…)` and backticks included whole. */
const wordAt = (text: string, at: number) => {
  let end = at;
  while (end < text.length && !OP.test(text.slice(end, end + 1))) {
    const char = text[end]!;
    if (char === "\\") end += 2;
    else if (char === "'") end = text.indexOf("'", end + 1) + 1 || text.length;
    else if (char === "`") end = text.indexOf("`", end + 1) + 1 || text.length;
    else if (char === '"') {
      end += 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      end += 1;
    } else if (text.startsWith("$(", end)) {
      let depth = 0;
      do {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")") depth -= 1;
        end += 1;
      } while (end < text.length && depth > 0);
    } else end += 1;
  }
  return text.slice(at, Math.min(end, text.length));
};

/**
 * Shell text with what never runs blanked: comments, `case` patterns and the words `echo` and
 * `printf` print. Words that run something (`$(…)`, backticks) and redirect targets stay.
 */
export const runnableText = (text: string): string => {
  let out = "";
  let at = 0;
  let commandStart = true;
  let printing = false;
  let redirect = false;
  const cases: Array<"subject" | "in" | "pattern" | "body"> = [];
  while (at < text.length) {
    const op = OP.exec(text.slice(at))?.[0];
    const state = cases.at(-1);
    if (op !== undefined) {
      at += op.length;
      out += op;
      if (op === "<" || op === ">") redirect = true;
      else if (SEPARATORS.has(op) && !(op === "&" && redirect)) {
        printing = false;
        commandStart = true;
      }
      if (op === ")" && state === "pattern") {
        cases[cases.length - 1] = "body";
        commandStart = true;
      } else if (op.startsWith(";;") || op === ";&") {
        if (state === "body") cases[cases.length - 1] = "pattern";
      }
      continue;
    }
    if (text[at] === "#" && !/[^\s;&|()<>]/.test(text[at - 1] ?? " ")) {
      const end = text.indexOf("\n", at);
      at = end === -1 ? text.length : end;
      continue;
    }
    const word = wordAt(text, at);
    at += word.length;
    const runs = /\$\(|`/.test(word);
    let keep = true;
    // A `case` word not followed by its subject and `in` was no `case` statement.
    if (state === "in" && word !== "in") cases.pop();
    if (state === "subject") cases[cases.length - 1] = "in";
    else if (state === "in" && word === "in") cases[cases.length - 1] = "pattern";
    else if (state === "pattern" || (state === "body" && commandStart && word === "esac")) {
      if (word === "esac") cases.pop();
      keep = false;
    } else if (redirect) redirect = false;
    else if (printing) keep = runs;
    else if (commandStart && word === "case") cases.push("subject");
    else if (commandStart && (word === "echo" || word === "printf")) printing = true;
    commandStart = commandStart && OPENERS.has(word);
    out += keep ? word : " ";
  }
  return out;
};
