import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as GitVcsDriver from "./GitVcsDriver.ts";

const SNAPSHOT_NAMESPACE = "refs/t3/snapshots";
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const OUTPUT_LIMIT = 16 * 1024 * 1024;

export class WorktreeSnapshotError extends Schema.TaggedError<WorktreeSnapshotError>()(
  "WorktreeSnapshotError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

type Execute = GitVcsDriver.GitVcsDriver["Service"]["execute"];

export interface WorktreeSnapshot {
  readonly ref: string;
  readonly snapshotSha: string;
  /** The commit the worktree was on when the snapshot was taken. */
  readonly headSha: string;
  readonly capturedAt: number;
}

const threadRefPrefix = (threadId: string) =>
  `${SNAPSHOT_NAMESPACE}/${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}`;

const identity = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "snapshots@t3.invalid",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "snapshots@t3.invalid",
};

const gitlinks = (listing: string) =>
  new Set(
    listing
      .split("\0")
      .filter((entry) => entry.startsWith("160000 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
  );

const run = (execute: Execute, cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  execute({
    operation: "WorktreeSnapshot.git",
    cwd,
    args,
    ...(env === undefined ? {} : { env }),
    maxOutputBytes: OUTPUT_LIMIT,
  }).pipe(Effect.map((result) => result.stdout));

const listSnapshotRefs = (execute: Execute, cwd: string, prefix: string) =>
  run(execute, cwd, ["for-each-ref", "--format=%(refname)", prefix]).pipe(
    Effect.map((out) =>
      out
        .split("\n")
        .map((ref) => ref.trim())
        .filter((ref) => ref !== "")
        .map((ref) => ({ ref, capturedAt: Number(ref.slice(ref.lastIndexOf("/") + 1)) }))
        .filter((entry) => Number.isFinite(entry.capturedAt)),
    ),
  );

/**
 * Saves the worktree's tracked, staged and untracked (not ignored) state under a ref, using a
 * temporary copy of the index so the checkout is untouched. Returns null when nothing changed.
 * Snapshot `^1` is HEAD, `^2` holds the staged state.
 */
export const captureWorktreeSnapshot = Effect.fn("WorktreeSnapshot.capture")(function* (input: {
  readonly execute: Execute;
  readonly cwd: string;
  readonly threadId: string;
  readonly now: number;
}) {
  const { execute, cwd } = input;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (detail: string) => new WorktreeSnapshotError({ detail });
  const status = yield* run(execute, cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.trim() === "") return null;

  const untracked = (yield* run(execute, cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  let total = 0;
  for (const name of untracked) {
    const size = Number(
      (yield* fs.stat(path.join(cwd, name)).pipe(Effect.orElseSucceed(() => ({ size: 0 })))).size,
    );
    total += size;
    if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES)
      return yield* fail("Untracked files are too large to snapshot.");
  }

  const headSha = (yield* run(execute, cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const indexTree = (yield* run(execute, cwd, ["write-tree"])).trim();
  const indexSha = (yield* run(
    execute,
    cwd,
    ["commit-tree", indexTree, "-p", headSha, "-m", "t3 index snapshot"],
    identity,
  )).trim();
  const indexFile = path.resolve(
    cwd,
    (yield* run(execute, cwd, ["rev-parse", "--git-path", "index"])).trim(),
  );
  const snapshotSha = yield* Effect.scoped(
    Effect.gen(function* () {
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-snapshot-" });
      const tempIndex = path.join(tmp, "index");
      yield* fs.copyFile(indexFile, tempIndex);
      const env = { ...identity, GIT_INDEX_FILE: tempIndex };
      yield* run(execute, cwd, ["add", "-A", "--"], env);
      // A nested repository would be saved as a bare gitlink and its files lost with the worktree.
      const before = gitlinks(yield* run(execute, cwd, ["ls-files", "-s", "-z"]));
      for (const link of gitlinks(yield* run(execute, cwd, ["ls-files", "-s", "-z"], env)))
        if (!before.has(link)) return yield* fail(`Contains a nested Git repository (${link}).`);
      const tree = (yield* run(execute, cwd, ["write-tree"], env)).trim();
      return (yield* run(
        execute,
        cwd,
        ["commit-tree", tree, "-p", headSha, "-p", indexSha, "-m", "t3 worktree snapshot"],
        identity,
      )).trim();
    }),
  );
  const ref = `${threadRefPrefix(input.threadId)}/${input.now}`;
  yield* run(execute, cwd, ["update-ref", ref, snapshotSha]);
  const stored = (yield* run(execute, cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  if (stored !== snapshotSha) return yield* fail("The snapshot could not be verified.");
  return { ref, snapshotSha, headSha, capturedAt: input.now } satisfies WorktreeSnapshot;
});

/** The newest snapshot of a thread, or null when none was taken or it has expired. */
export const latestWorktreeSnapshot = Effect.fn("WorktreeSnapshot.latest")(function* (input: {
  readonly execute: Execute;
  readonly cwd: string;
  readonly threadId: string;
}) {
  const refs = yield* listSnapshotRefs(input.execute, input.cwd, threadRefPrefix(input.threadId));
  const newest = refs.reduce<(typeof refs)[number] | null>(
    (best, entry) => (best === null || entry.capturedAt > best.capturedAt ? entry : best),
    null,
  );
  if (newest === null) return null;
  const snapshotSha = (yield* run(input.execute, input.cwd, [
    "rev-parse",
    "--verify",
    `${newest.ref}^{commit}`,
  ])).trim();
  const headSha = (yield* run(input.execute, input.cwd, [
    "rev-parse",
    "--verify",
    `${snapshotSha}^1`,
  ])).trim();
  return { ref: newest.ref, snapshotSha, headSha, capturedAt: newest.capturedAt } as const;
});

/**
 * Writes a snapshot into a freshly created worktree whose branch is checked out. When the branch
 * moved since the snapshot the changes are merged by Git's trivial three-way rules, and a
 * conflict fails instead of leaving a half-applied tree.
 */
export const restoreWorktreeSnapshot = Effect.fn("WorktreeSnapshot.restore")(function* (input: {
  readonly execute: Execute;
  readonly cwd: string;
  readonly snapshot: Pick<WorktreeSnapshot, "snapshotSha" | "headSha">;
}) {
  const { execute, cwd, snapshot } = input;
  const head = (yield* run(execute, cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const sameBase = head === snapshot.headSha;
  yield* run(
    execute,
    cwd,
    sameBase
      ? ["read-tree", "-m", "-u", "HEAD", snapshot.snapshotSha]
      : ["read-tree", "-m", "-u", snapshot.headSha, "HEAD", snapshot.snapshotSha],
  ).pipe(
    Effect.mapError(
      (cause) =>
        new WorktreeSnapshotError({
          detail:
            "The branch changed since the snapshot and the saved changes no longer apply cleanly.",
          cause,
        }),
    ),
  );
  if ((yield* run(execute, cwd, ["ls-files", "-u"])).trim() !== "")
    return yield* new WorktreeSnapshotError({
      detail: "The branch changed since the snapshot and the saved changes conflict with it.",
    });
  // Back to the staged state the thread had; files themselves stay as written.
  yield* run(
    execute,
    cwd,
    sameBase ? ["read-tree", `${snapshot.snapshotSha}^2`] : ["reset", "--quiet"],
  );
});

/** Deletes a thread's snapshots once they have been restored. */
export const dropWorktreeSnapshots = Effect.fn("WorktreeSnapshot.drop")(function* (input: {
  readonly execute: Execute;
  readonly cwd: string;
  readonly threadId: string;
}) {
  const refs = yield* listSnapshotRefs(input.execute, input.cwd, threadRefPrefix(input.threadId));
  for (const { ref } of refs) yield* run(input.execute, input.cwd, ["update-ref", "-d", ref]);
});

/** Deletes snapshots older than `olderThanMs`; the capture time is the ref's last component. */
export const pruneWorktreeSnapshots = Effect.fn("WorktreeSnapshot.prune")(function* (input: {
  readonly execute: Execute;
  readonly cwd: string;
  readonly olderThanMs: number;
}) {
  const refs = yield* listSnapshotRefs(input.execute, input.cwd, SNAPSHOT_NAMESPACE);
  let pruned = 0;
  for (const { ref, capturedAt } of refs) {
    if (capturedAt >= input.olderThanMs) continue;
    yield* run(input.execute, input.cwd, ["update-ref", "-d", ref]);
    pruned++;
  }
  return pruned;
});
