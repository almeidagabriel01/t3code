// @effect-diagnostics nodeBuiltinImport:off
/** How a `t3 heavy` command becomes its queue entry: plain Node, shared by the CLI and the probe. */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { lineParts, scriptsOf, shellQuote, type ReadScript } from "./heavyHook.ts";
import { startFolder, type QueuedEntry } from "./runner.ts";

const LABEL_CHARS = 200;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);

/**
 * The job a command really is. A shell line's leading `cd <dir> &&` steps become the folder it
 * starts from, so the queue, its project settings and Linux all see that folder, and an agent's own
 * `remoto` around the command is dropped.
 */
export const jobOf = (
  program: string,
  args: ReadonlyArray<string>,
  cwd: string,
  home: string,
): {
  readonly cwd: string;
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly remoto: boolean;
} => {
  if (NodePath.basename(program) === "remoto") {
    // `remoto` alone has no command: an empty one, which the queue refuses as `remoto`'s misuse.
    return { cwd, program: args[0] ?? "", args: args.slice(1), remoto: true };
  }
  const at = lineAt(program, args);
  if (at === null) return { cwd, program, args, remoto: false };
  const parts = lineParts(args[at]!);
  return {
    cwd: startFolder(parts.dirs, cwd, home),
    program,
    args: args.with(at, parts.command),
    remoto: parts.remoto,
  };
};

/**
 * A hook-wrapped `$SHELL -c '<line>'` is labelled by the line itself, so names and history keep it.
 * Any other program by its name, as Linux runs it (`remoteCommand`).
 */
export const labelOf = (program: string, args: ReadonlyArray<string>) =>
  (lineOf(program, args) ?? [NodePath.basename(program), ...args].join(" ")).slice(0, LABEL_CHARS);

/**
 * Where a shell's `-c` line sits among its words: `sh -c`, `bash -lc`, `bash -ec`, `bash --login -c`.
 * Null for any other program, or a shell option that takes a value (`-o pipefail`) before `-c`.
 */
export const lineAt = (program: string, args: ReadonlyArray<string>) => {
  if (!SHELLS.has(NodePath.basename(program))) return null;
  for (let at = 0; at + 1 < args.length && args[at]!.startsWith("-") && args[at] !== "--"; at++) {
    if (/^-[a-z]*c[a-z]*$/i.test(args[at]!)) return at + 1;
  }
  return null;
};

export const lineOf = (program: string, args: ReadonlyArray<string>) => {
  const at = lineAt(program, args);
  return at === null ? null : args[at]!;
};

/** The line a job runs, as a shell reads it: a program run without a shell is its quoted words. */
export const jobLine = (program: string, args: ReadonlyArray<string>) =>
  lineOf(program, args) ?? [program, ...args].map(shellQuote).join(" ");

/**
 * The queue entry a `t3 heavy` job is, built one way for the real job and for a probe of it, so
 * both get the same label, line, scripts and request key.
 */
export const jobEntryOf = (
  job: Pick<
    QueuedEntry,
    | "id"
    | "pid"
    | "threadId"
    | "cwd"
    | "createdAt"
    | "priority"
    | "name"
    | "routeReason"
    | "where"
    | "forced"
    | "ssh"
  > & { readonly program: string; readonly args: ReadonlyArray<string> },
  readScript: ReadScript,
): QueuedEntry => {
  const { program, args, ...rest } = job;
  const label = labelOf(program, args);
  const line = jobLine(program, args);
  // The scripts it runs travel with the job: the Runner judges them by their text.
  const scripts = scriptsOf(line, readScript);
  return {
    ...rest,
    label,
    ...(line === label ? {} : { line }),
    ...(Object.keys(scripts).length === 0 ? {} : { scripts }),
    startedAt: null,
    // A retry of the same request takes back its orphaned place.
    ...(job.threadId === null
      ? {}
      : {
          requestKey: NodeCrypto.createHash("sha1")
            .update(`${job.threadId}|${job.cwd}|${line}`)
            .digest("hex"),
        }),
  };
};
