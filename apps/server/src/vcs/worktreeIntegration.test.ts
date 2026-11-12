import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { integratedInto, parseWorktreeList } from "./worktreeIntegration.ts";

describe("worktree list", () => {
  it("reads every record's flags, and the first one as the main worktree", () => {
    const output = [
      "worktree /repo\0HEAD aaa\0branch refs/heads/main\0",
      "worktree /wt/a\0HEAD bbb\0detached\0locked agent at work\0",
      "worktree /wt/gone\0HEAD ccc\0branch refs/heads/gone\0prunable gitdir file points nowhere\0",
      "worktree /bare\0bare\0",
      "\0",
    ].join("\0");
    expect(parseWorktreeList(output)).toEqual([
      {
        path: "/repo",
        head: "aaa",
        branch: "refs/heads/main",
        main: true,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: "/wt/a",
        head: "bbb",
        branch: null,
        main: false,
        bare: false,
        locked: true,
        prunable: false,
      },
      {
        path: "/wt/gone",
        head: "ccc",
        branch: "refs/heads/gone",
        main: false,
        bare: false,
        locked: false,
        prunable: true,
      },
      {
        path: "/bare",
        head: null,
        branch: null,
        main: false,
        bare: true,
        locked: false,
        prunable: false,
      },
    ]);
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("integration check", () => {
  it.effect("counts a base Git cannot read as unknown, never as integrated", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-integration-" });
      const run = (...args: string[]) => git.execute({ operation: "test", cwd: repo, args });
      yield* run("init", "-b", "main");
      yield* run(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "one",
      );
      const head = (yield* run("rev-parse", "HEAD")).stdout.trim();
      expect(
        yield* integratedInto({
          execute: git.execute,
          cwd: repo,
          head,
          bases: ["refs/heads/missing"],
        }),
      ).toEqual({ integrated: false, unknown: true });
      expect(
        yield* integratedInto({
          execute: git.execute,
          cwd: repo,
          head,
          bases: ["refs/heads/missing", "refs/heads/main"],
        }),
      ).toEqual({ integrated: true, base: "refs/heads/main" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(GitVcsDriver.layer, ProcessRunner.layer).pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-integration-" })),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
