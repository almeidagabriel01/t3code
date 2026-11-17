/**
 * A job's cost class, from its line and its usual run: `quick` checks a few files or usually ends
 * within `quickSeconds`, `service` never ends by itself, `standard` is everything else. Derived,
 * never stored, so waiters of any build read the same queue file the same way.
 */
import type { HeavyQueueEntry } from "@t3tools/contracts";

import { keepsRunning, kindOf } from "./commandShapes.ts";
import { commitOnly, readLine, workParts, type Part } from "./heavyHook.ts";

export type CostClass = "quick" | "standard" | "service";
export interface Cost {
  readonly class: CostClass;
  readonly why: string;
}

const isFile = (word: string) =>
  /\.[A-Za-z0-9]{1,5}$/.test(word) && !/[*?[$]/.test(word) && word !== ".";
/** A word naming something to work on rather than a subcommand: a path, a glob or a variable. */
const isTarget = (word: string) => isFile(word) || /[\\/*?[$]/.test(word);

const SHELL_TEXT = /^-[a-z]*c[a-z]*$/;

/** A part's own work, or the work of the line it runs with `sh -c`. */
const workOf = (part: Part): ReadonlyArray<Part> => {
  if (part.nested === null) return [part];
  const values = part.values.slice(part.programAt);
  const text = values[values.findIndex((value) => SHELL_TEXT.test(value)) + 1];
  return text === undefined ? [part] : workPartsOf(text);
};

/** The files a checking part works on, or null when it has no file scope (A3). */
export const filesOf = (part: Part): ReadonlyArray<string> | null => {
  const text = part.values.slice(part.remoteAt).join(" ");
  if (part.script !== null || kindOf({ label: text }) !== "medium") return null;
  const targets = part.words.filter(isTarget);
  const readsFile =
    part.flags.some((flag) => /^--stdin-filepath(=|$)/.test(flag)) ||
    part.command.redirects.some(
      (redirect) => redirect.op.endsWith("<") && redirect.target?.value !== "/dev/null",
    );
  if (targets.length > 0 && targets.every(isFile)) return targets;
  return readsFile && targets.length === 0 ? [] : null;
};

/** Files a loop or an array of the line names (`for f in a.ts`, `files=(a.ts b.ts)`). */
const listedFiles = (line: string) =>
  [...line.matchAll(/\bin\s+([^;\n]*?)\s*;\s*do\b|\w+=\(([^)]*)\)/g)].flatMap((match) =>
    (match[1] ?? match[2] ?? "")
      .split(/\s+/)
      .map((word) => word.replace(/^["']|["']$/g, ""))
      .filter(isFile),
  );

const duration = (ms: number) =>
  ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

/**
 * The work of a line, with each `sh -c` text read as its own line. A long-running part counts even
 * beside heavy work, which `workParts` alone would keep to.
 */
export const workPartsOf = (line: string): ReadonlyArray<Part> => {
  const { parts } = readLine(line);
  const work = new Set(workParts(parts));
  return parts
    .filter(
      (part) =>
        work.has(part) ||
        (!part.remotoInside && keepsRunning(part.program, part.words, part.flags)),
    )
    .flatMap(workOf);
};

const classOf = (line: string, durationMs: number | null, quickSeconds: number): Cost => {
  if (commitOnly(line) !== null) return { class: "quick", why: "staged files" };
  const parts = workPartsOf(line);
  const service = parts.filter((part) => keepsRunning(part.program, part.words, part.flags));
  if (parts.length > 0 && service.length === parts.length) {
    return { class: "service", why: "keeps running" };
  }
  // The line ends only when its long-running part does: never quick, whatever the rest is.
  if (service.length > 0) return { class: "standard", why: "part of it keeps running" };
  const scopes = parts.map(filesOf);
  if (parts.length > 0 && scopes.every((files) => files !== null)) {
    const named = new Set(scopes.flat());
    const files = Math.max(1, named.size > 0 ? named.size : new Set(listedFiles(line)).size);
    return { class: "quick", why: `${files} file${files === 1 ? "" : "s"}` };
  }
  if (durationMs === null) return { class: "standard", why: "first run" };
  return {
    class: durationMs <= quickSeconds * 1000 ? "quick" : "standard",
    why: `usually ${duration(durationMs)}`,
  };
};

/**
 * `durationMs`: the command's usual run on the machine it goes to, null without one. Anything the
 * parser trips on is a standard job, as every job was before cost classes.
 */
export const costOf = (
  entry: Pick<HeavyQueueEntry, "label"> & { readonly line?: string },
  durationMs: number | null,
  quickSeconds: number,
): Cost => {
  try {
    return classOf(entry.line ?? entry.label, durationMs, quickSeconds);
  } catch {
    return { class: "standard", why: "first run" };
  }
};
