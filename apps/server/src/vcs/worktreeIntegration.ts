import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type * as GitVcsDriver from "./GitVcsDriver.ts";

type Execute = GitVcsDriver.GitVcsDriver["Service"]["execute"];

export interface ListedWorktree {
  readonly path: string;
  readonly head: string | null;
  /** Full ref name, or null when detached. */
  readonly branch: string | null;
  readonly main: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  /** Registered, but its directory is gone. */
  readonly prunable: boolean;
}

/** Parses `git worktree list --porcelain -z`; the first record is always the main worktree. */
export function parseWorktreeList(output: string): ListedWorktree[] {
  const worktrees: ListedWorktree[] = [];
  for (const record of output.split("\0\0")) {
    const fields = record.split("\0").filter((field) => field !== "");
    const location = fields.find((field) => field.startsWith("worktree "));
    if (location === undefined) continue;
    const value = (name: string) => {
      const field = fields.find((entry) => entry === name || entry.startsWith(`${name} `));
      return field === undefined ? undefined : field.slice(name.length + 1);
    };
    worktrees.push({
      path: location.slice("worktree ".length),
      head: value("HEAD") ?? null,
      branch: value("branch") ?? null,
      main: worktrees.length === 0,
      bare: value("bare") !== undefined,
      locked: value("locked") !== undefined,
      prunable: value("prunable") !== undefined,
    });
  }
  return worktrees;
}

export const listWorktrees = Effect.fn("WorktreeIntegration.listWorktrees")(function* (
  execute: Execute,
  cwd: string,
) {
  const result = yield* execute({
    operation: "WorktreeIntegration.listWorktrees",
    cwd,
    args: ["worktree", "list", "--porcelain", "-z"],
    maxOutputBytes: 4 * 1024 * 1024,
  });
  // A cut-off list could drop the main record's position or a lock line; trust none of it.
  return result.stdoutTruncated ? null : parseWorktreeList(result.stdout);
});

export type Integration =
  | { readonly integrated: true; readonly base: string }
  | { readonly integrated: false; readonly unknown: boolean };

/**
 * Whether `head` adds nothing to any of `bases`: an ancestor of one, or (squash and cherry-pick
 * merges) merging it into one leaves that base's tree unchanged. Any probe Git cannot answer, such
 * as a Git without `merge-tree --write-tree`, counts as not integrated.
 */
export const integratedInto = Effect.fn("WorktreeIntegration.integratedInto")(function* (input: {
  readonly execute: Execute;
  readonly cwd: string;
  readonly head: string;
  readonly bases: ReadonlyArray<string>;
}) {
  const git = (args: string[]) =>
    input.execute({
      operation: "WorktreeIntegration.integratedInto",
      cwd: input.cwd,
      args,
      allowNonZeroExit: true,
      maxOutputBytes: 1024 * 1024,
    });
  let unknown = false;
  for (const base of input.bases) {
    const ancestor = yield* git(["merge-base", "--is-ancestor", input.head, base]);
    if (ancestor.exitCode === 0) return { integrated: true, base } satisfies Integration;
    if (ancestor.exitCode !== 1) {
      unknown = true;
      continue;
    }
    const merged = yield* git(["merge-tree", "--write-tree", "--no-messages", base, input.head]);
    // Exit 1 is a conflict: the head changes something the base changed differently.
    if (merged.exitCode === 1) continue;
    const baseTree = yield* git(["rev-parse", "--verify", `${base}^{tree}`]);
    if (merged.exitCode !== 0 || baseTree.exitCode !== 0) {
      unknown = true;
      continue;
    }
    if (merged.stdout.split("\n")[0]?.trim() === baseTree.stdout.trim())
      return { integrated: true, base } satisfies Integration;
  }
  return { integrated: false, unknown } satisfies Integration;
});

/** The per-worktree admin folder (`<repo>/.git/worktrees/<name>`) a linked worktree's `.git` file names. */
export const worktreeAdminDir = Effect.fn("WorktreeIntegration.worktreeAdminDir")(function* (
  worktreePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.join(worktreePath, ".git"));
  const match = /^gitdir: (.+)$/m.exec(text);
  return match === null ? null : path.resolve(worktreePath, match[1]!.trim());
});

const FINISHED_MARKER = "t3-finished";

/** Records that an agent finished with this worktree. It lives and dies with the worktree's own Git metadata. */
export const markWorktreeFinished = Effect.fn("WorktreeIntegration.markFinished")(function* (
  adminDir: string,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const marker = path.join(adminDir, FINISHED_MARKER);
  if (yield* fs.exists(marker)) return;
  yield* fs.writeFileString(marker, `${DateTime.formatIso(DateTime.makeUnsafe(now))}\n`);
});

export const worktreeFinished = Effect.fn("WorktreeIntegration.worktreeFinished")(
  function* (adminDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.exists(path.join(adminDir, FINISHED_MARKER));
  },
  Effect.orElseSucceed(() => false),
);

// One stat per file, inside worktreeTimes' span.
const modifiedAt = Effect.fnUntraced(
  function* (target: string) {
    const fs = yield* FileSystem.FileSystem;
    return Option.getOrNull((yield* fs.stat(target)).mtime)?.getTime() ?? null;
  },
  Effect.orElseSucceed(() => null),
);

/**
 * When a worktree with no thread was created and last used. Git rewrites the `.git` file only when
 * the worktree is added, moved or repaired; HEAD and its reflog move with every checkout and commit.
 */
export const worktreeTimes = Effect.fn("WorktreeIntegration.worktreeTimes")(function* (
  worktreePath: string,
  adminDir: string,
) {
  const path = yield* Path.Path;
  const createdAt = yield* modifiedAt(path.join(worktreePath, ".git"));
  const used = yield* Effect.forEach(
    [path.join(adminDir, "HEAD"), path.join(adminDir, "logs", "HEAD")],
    modifiedAt,
  );
  const times = [createdAt, ...used].filter((time) => time !== null);
  return { createdAt, activeAt: times.length === 0 ? null : Math.max(...times) };
});
