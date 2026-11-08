import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { captureWorktreeSnapshot, pruneWorktreeSnapshots } from "../vcs/worktreeSnapshot.ts";
import { layerRealGit } from "./ProviderTurnStartService.testkit.ts";
import { makeThreadWorkspace } from "./ThreadWorkspace.ts";

const threadId = ThreadId.make("thread-1");

// A repository with a managed-location worktree holding edits, then cleaned up as cleanup would.
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "thread-ws-" }));
  const repo = path.join(root, "project");
  const git = (cwd: string, ...args: string[]) =>
    driver
      .execute({ operation: "test", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* fs.makeDirectory(repo);
  yield* git(repo, "init", "-b", "main");
  yield* git(repo, "config", "user.email", "t@example.com");
  yield* git(repo, "config", "user.name", "T");
  yield* fs.writeFileString(path.join(repo, "a.txt"), "a\n");
  yield* git(repo, "add", ".");
  yield* git(repo, "commit", "-m", "init");
  const worktreePath = path.join(yield* fs.realPath(config.worktreesDir), "project", "feat");
  yield* fs.makeDirectory(path.dirname(worktreePath), { recursive: true });
  yield* git(repo, "worktree", "add", "-b", "feat", worktreePath);
  yield* fs.writeFileString(path.join(worktreePath, "a.txt"), "edited\n");
  yield* fs.writeFileString(path.join(worktreePath, "new.txt"), "untracked\n");
  const snapshot = yield* captureWorktreeSnapshot({
    execute: driver.execute,
    cwd: worktreePath,
    threadId,
    now: 1_000,
  });
  yield* git(repo, "worktree", "remove", "--force", worktreePath);
  const shell = {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    worktreePath,
    branch: "feat",
  };
  return { fs, path, driver, repo, root, worktreePath, git, shell, snapshot };
});

const layer = (workspaceRoot: () => string | null) =>
  Layer.mergeAll(
    layerRealGit,
    ServerSettings.layerTest(),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome({ workspaceRoot: workspaceRoot() } as never),
    }),
  );

const run = <A, E>(
  body: (
    ctx: Effect.Success<typeof setup> & { workspace: Effect.Success<typeof makeThreadWorkspace> },
  ) => Effect.Effect<A, E>,
) => {
  let root: string | null = null;
  return Effect.gen(function* () {
    const ctx = yield* setup;
    root = ctx.repo;
    const workspace = yield* makeThreadWorkspace;
    return yield* body({ ...ctx, workspace });
  }).pipe(Effect.scoped, Effect.provide(layer(() => root)));
};

it.live("status reports a cleaned thread, and restore brings its changes back", () =>
  run(({ fs, path, git, worktreePath, shell, workspace }) =>
    Effect.gen(function* () {
      const status = yield* workspace.status(shell);
      assert.strictEqual(status.state, "cleaned");
      assert.isNotNull(status.snapshot);
      const result = yield* workspace.restore(shell);
      assert.isTrue(result.restoredSnapshot);
      assert.strictEqual(yield* fs.readFileString(path.join(worktreePath, "a.txt")), "edited\n");
      assert.strictEqual(
        yield* fs.readFileString(path.join(worktreePath, "new.txt")),
        "untracked\n",
      );
      assert.strictEqual(yield* git(worktreePath, "branch", "--show-current"), "feat");
      assert.deepEqual(yield* workspace.status(shell), { state: "ready", snapshot: null });
      // A second restore is a no-op, so a click racing a turn start is harmless.
      assert.isFalse((yield* workspace.restore(shell)).restoredSnapshot);
    }),
  ),
);

it.live("restore recreates a branch that was deleted since cleanup at the snapshot's base", () =>
  run(({ fs, path, git, repo, worktreePath, shell, workspace }) =>
    Effect.gen(function* () {
      yield* git(repo, "branch", "-D", "feat");
      yield* fs.writeFileString(path.join(repo, "other.txt"), "main moved\n");
      yield* git(repo, "add", ".");
      yield* git(repo, "commit", "-m", "main moved");
      const result = yield* workspace.restore(shell);
      assert.isTrue(result.restoredSnapshot);
      assert.strictEqual(yield* git(worktreePath, "branch", "--show-current"), "feat");
      assert.isFalse(yield* fs.exists(path.join(worktreePath, "other.txt")));
      assert.strictEqual(yield* fs.readFileString(path.join(worktreePath, "a.txt")), "edited\n");
    }),
  ),
);

it.live("an expired snapshot is reported and restore falls back to the branch alone", () =>
  run(({ fs, path, driver, repo, worktreePath, shell, workspace }) =>
    Effect.gen(function* () {
      yield* pruneWorktreeSnapshots({ execute: driver.execute, cwd: repo, olderThanMs: 2_000 });
      assert.deepEqual(yield* workspace.status(shell), { state: "cleaned", snapshot: null });
      const result = yield* workspace.restore(shell);
      assert.isFalse(result.restoredSnapshot);
      assert.strictEqual(yield* fs.readFileString(path.join(worktreePath, "a.txt")), "a\n");
      assert.isFalse(yield* fs.exists(path.join(worktreePath, "new.txt")));
    }),
  ),
);

it.live("a snapshot that no longer applies fails, removes the worktree and keeps the ref", () =>
  run(({ fs, path, git, repo, worktreePath, shell, workspace, snapshot }) =>
    Effect.gen(function* () {
      yield* git(repo, "worktree", "add", worktreePath, "feat");
      yield* fs.writeFileString(path.join(worktreePath, "a.txt"), "conflicting\n");
      yield* git(worktreePath, "commit", "-am", "conflict");
      yield* git(repo, "worktree", "remove", "--force", worktreePath);
      const failure = yield* Effect.flip(workspace.restore(shell));
      assert.include(failure.message, snapshot!.ref);
      assert.isFalse(yield* fs.exists(worktreePath));
      assert.strictEqual((yield* workspace.status(shell)).state, "cleaned");
      assert.isNotNull((yield* workspace.status(shell)).snapshot);
    }),
  ),
);

it.live("threads without a restorable worktree stay ready", () =>
  run(({ fs, path, root, git, repo, worktreePath, shell, workspace }) =>
    Effect.gen(function* () {
      const ready = { state: "ready", snapshot: null } as const;
      assert.deepEqual(yield* workspace.status(null), ready);
      assert.deepEqual(yield* workspace.status({ ...shell, worktreePath: null }), ready);
      // Outside the managed folder nothing is recreated.
      const outside = { ...shell, worktreePath: path.join(root, "elsewhere") };
      assert.deepEqual(yield* workspace.status(outside), ready);
      assert.isFalse((yield* workspace.restore(outside)).restoredSnapshot);
      // A present worktree needs nothing.
      yield* git(repo, "worktree", "add", worktreePath, "feat");
      assert.deepEqual(yield* workspace.status(shell), ready);
      yield* fs.remove(path.join(repo, ".git"), { recursive: true });
      yield* fs.remove(worktreePath, { recursive: true });
      // A project that is no longer a repository cannot recreate one.
      assert.deepEqual(yield* workspace.status(shell), ready);
    }),
  ),
);
