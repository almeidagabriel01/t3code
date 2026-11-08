import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import {
  captureWorktreeSnapshot,
  dropWorktreeSnapshots,
  latestWorktreeSnapshot,
  pruneWorktreeSnapshots,
  restoreWorktreeSnapshot,
} from "./worktreeSnapshot.ts";

const layer = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-snapshot-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const setup = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-repo-" }));
  const repo = path.join(root, "main");
  const execute = git.execute;
  const sh = (cwd: string, ...args: string[]) =>
    execute({ operation: "test", cwd, args }).pipe(Effect.map((r) => r.stdout.trim()));
  yield* fs.makeDirectory(repo);
  yield* sh(repo, "init", "-b", "main");
  yield* sh(repo, "config", "user.email", "t@example.com");
  yield* sh(repo, "config", "user.name", "T");
  yield* fs.writeFileString(path.join(repo, "a.txt"), "a\n");
  yield* fs.writeFileString(path.join(repo, "gone.txt"), "gone\n");
  yield* fs.writeFileString(path.join(repo, ".gitignore"), "ignored.log\n");
  yield* sh(repo, "add", ".");
  yield* sh(repo, "commit", "-m", "init");
  const addWorktree = (name: string) =>
    sh(repo, "worktree", "add", "-b", name, path.join(root, name)).pipe(
      Effect.as(path.join(root, name)),
    );
  return { fs, path, repo, root, execute, sh, addWorktree };
});

it.live("capture saves dirty and untracked state without touching the checkout", () =>
  Effect.gen(function* () {
    const { fs, path, execute, sh, addWorktree } = yield* setup;
    const wt = yield* addWorktree("feat");
    yield* fs.writeFileString(path.join(wt, "a.txt"), "edited\n");
    yield* fs.remove(path.join(wt, "gone.txt"));
    yield* fs.writeFileString(path.join(wt, "new.txt"), "untracked\n");
    yield* fs.writeFileString(path.join(wt, "ignored.log"), "noise\n");
    yield* sh(wt, "add", "a.txt");
    const before = yield* sh(wt, "status", "--porcelain");
    const snap = yield* captureWorktreeSnapshot({ execute, cwd: wt, threadId: "t/1", now: 5 });
    assert.isNotNull(snap);
    assert.strictEqual(yield* sh(wt, "status", "--porcelain"), before);
    assert.strictEqual(yield* sh(wt, "show", `${snap!.ref}:new.txt`), "untracked");
    assert.strictEqual(yield* sh(wt, "show", `${snap!.ref}:a.txt`), "edited");
    const files = yield* sh(wt, "ls-tree", "-r", "--name-only", snap!.ref);
    assert.notInclude(files, "ignored.log");
    assert.notInclude(files, "gone.txt");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("capture returns null for a clean worktree and refuses nested repositories", () =>
  Effect.gen(function* () {
    const { fs, path, execute, sh, addWorktree } = yield* setup;
    const wt = yield* addWorktree("clean");
    assert.isNull(yield* captureWorktreeSnapshot({ execute, cwd: wt, threadId: "t", now: 1 }));
    yield* fs.makeDirectory(path.join(wt, "inner"));
    yield* sh(path.join(wt, "inner"), "init");
    yield* fs.writeFileString(path.join(wt, "inner", "x.txt"), "x");
    yield* sh(path.join(wt, "inner"), "add", ".");
    yield* sh(
      path.join(wt, "inner"),
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-m",
      "x",
    );
    const failure = yield* Effect.flip(
      captureWorktreeSnapshot({ execute, cwd: wt, threadId: "t", now: 1 }),
    );
    assert.include(failure.message, "nested Git repository");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("round trip restores edits, deletions, untracked files and the staged split", () =>
  Effect.gen(function* () {
    const { fs, path, repo, root, execute, sh, addWorktree } = yield* setup;
    const wt = yield* addWorktree("feat");
    yield* fs.writeFileString(path.join(wt, "a.txt"), "edited\n");
    yield* fs.remove(path.join(wt, "gone.txt"));
    yield* fs.writeFileString(path.join(wt, "new.txt"), "untracked\n");
    yield* sh(wt, "add", "a.txt");
    const before = yield* sh(wt, "status", "--porcelain");
    const snap = yield* captureWorktreeSnapshot({ execute, cwd: wt, threadId: "t", now: 7 });
    yield* sh(repo, "worktree", "remove", "--force", wt);
    const latest = yield* latestWorktreeSnapshot({ execute, cwd: repo, threadId: "t" });
    assert.strictEqual(latest?.snapshotSha, snap!.snapshotSha);
    const fresh = path.join(root, "feat");
    yield* sh(repo, "worktree", "add", fresh, "feat");
    yield* restoreWorktreeSnapshot({ execute, cwd: fresh, snapshot: latest! });
    assert.strictEqual(yield* sh(fresh, "status", "--porcelain"), before);
    assert.strictEqual(yield* fs.readFileString(path.join(fresh, "a.txt")), "edited\n");
    assert.isFalse(yield* fs.exists(path.join(fresh, "gone.txt")));
    assert.strictEqual(yield* fs.readFileString(path.join(fresh, "new.txt")), "untracked\n");
    yield* dropWorktreeSnapshots({ execute, cwd: repo, threadId: "t" });
    assert.isNull(yield* latestWorktreeSnapshot({ execute, cwd: repo, threadId: "t" }));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("restore merges onto a moved branch and fails cleanly on conflict", () =>
  Effect.gen(function* () {
    const { fs, path, repo, root, execute, sh, addWorktree } = yield* setup;
    const wt = yield* addWorktree("feat");
    yield* fs.writeFileString(path.join(wt, "a.txt"), "mine\n");
    yield* fs.writeFileString(path.join(wt, "new.txt"), "n\n");
    const snap = yield* captureWorktreeSnapshot({ execute, cwd: wt, threadId: "t", now: 9 });
    yield* sh(repo, "worktree", "remove", "--force", wt);
    const fresh = path.join(root, "feat");
    // Another commit on the branch touches an unrelated file: applies cleanly.
    yield* sh(repo, "worktree", "add", fresh, "feat");
    yield* fs.writeFileString(path.join(fresh, "gone.txt"), "moved\n");
    yield* sh(fresh, "commit", "-am", "move");
    yield* restoreWorktreeSnapshot({ execute, cwd: fresh, snapshot: snap! });
    assert.strictEqual(yield* fs.readFileString(path.join(fresh, "a.txt")), "mine\n");
    assert.strictEqual(yield* fs.readFileString(path.join(fresh, "gone.txt")), "moved\n");
    // A conflicting commit makes the same restore fail instead of merging silently.
    yield* sh(repo, "worktree", "remove", "--force", fresh);
    yield* sh(repo, "branch", "-f", "feat", snap!.headSha);
    yield* sh(repo, "worktree", "add", fresh, "feat");
    yield* fs.writeFileString(path.join(fresh, "a.txt"), "theirs\n");
    yield* sh(fresh, "commit", "-am", "conflict");
    const failure = yield* Effect.flip(
      restoreWorktreeSnapshot({ execute, cwd: fresh, snapshot: snap! }),
    );
    assert.include(failure.message, "branch changed");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("prune removes only snapshots older than the cutoff", () =>
  Effect.gen(function* () {
    const { fs, path, repo, execute, addWorktree } = yield* setup;
    const wt = yield* addWorktree("feat");
    yield* fs.writeFileString(path.join(wt, "n.txt"), "n\n");
    yield* captureWorktreeSnapshot({ execute, cwd: wt, threadId: "t", now: 100 });
    yield* captureWorktreeSnapshot({ execute, cwd: wt, threadId: "u", now: 300 });
    assert.strictEqual(yield* pruneWorktreeSnapshots({ execute, cwd: repo, olderThanMs: 200 }), 1);
    assert.isNull(yield* latestWorktreeSnapshot({ execute, cwd: repo, threadId: "t" }));
    assert.isNotNull(yield* latestWorktreeSnapshot({ execute, cwd: repo, threadId: "u" }));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
