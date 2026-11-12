import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "./config.ts";
import { DEV_WORKTREE_CLEANUP_ENV, devWorktreeCleanupBlocked } from "./devWorktreeCleanupGuard.ts";

describe("dev worktree cleanup guard", () => {
  it.effect.each([
    ["an installed server", { checkout: false, devUrl: false, env: undefined }, false],
    ["a dev server", { checkout: false, devUrl: true, env: undefined }, true],
    ["a home inside a checkout", { checkout: true, devUrl: false, env: undefined }, true],
    ["a dev server asked to clean", { checkout: true, devUrl: true, env: "1" }, false],
    ["any other value", { checkout: true, devUrl: false, env: "true" }, true],
  ] as const)("%s: blocked %s", ([, setup, blocked]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-guard-" });
      // The home folder itself may be a dotfiles repository; it never counts.
      yield* fs.makeDirectory(`${home}/.git`);
      const checkout = `${home}/code/t3`;
      yield* fs.makeDirectory(`${checkout}/.t3`, { recursive: true });
      if (setup.checkout) yield* fs.writeFileString(`${checkout}/.git`, "gitdir: elsewhere\n");
      const baseDir = setup.checkout ? `${checkout}/.t3/userdata` : `${home}/.t3/userdata`;
      const config = yield* ServerConfig.ServerConfig;
      const result = yield* devWorktreeCleanupBlocked().pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          baseDir,
          devUrl: setup.devUrl ? new URL("http://localhost:5733") : undefined,
        }),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, { [DEV_WORKTREE_CLEANUP_ENV]: setup.env }),
      );
      expect(result).toBe(blocked);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-dev-guard-config-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
