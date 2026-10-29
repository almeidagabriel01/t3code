import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as MemoryHub from "./MemoryHubService.ts";
import { makeMemoryApplicationLayers } from "./MemoryApplicationLayers.ts";

it.live("the served environment descriptor advertises import once the reader is acquired", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    // The reader refuses symlinked ancestors, and macOS temp lives under a /var symlink.
    const baseDir = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-memory-layers-" })
      .pipe(Effect.flatMap((dir) => fileSystem.realPath(dir)));
    const config = yield* ServerConfig.ServerConfig.use(Effect.succeed).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    );
    yield* fileSystem.makeDirectory(config.stateDir, { recursive: true, mode: 0o700 });
    const app = makeMemoryApplicationLayers({
      layerPersistence: SqlitePersistence.layerMemory,
      layerRepositoryIdentityResolver: Layer.mock(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
      )({}),
      layerServerSettings: ServerSettings.layerTest({}, "memoryHub"),
      layerTextGeneration: Layer.mock(TextGeneration.TextGeneration)({}),
    });
    const descriptor = yield* ServerEnvironment.ServerEnvironment.use(
      (environment) => environment.getDescriptor,
    ).pipe(
      Effect.provide(
        app.layerServerEnvironment.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    expect(descriptor.capabilities.memory?.importProvider).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "the application exposes the hub administrator that sharing updates look up at call time",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-memory-hub-admin-" })
        .pipe(Effect.flatMap((dir) => fileSystem.realPath(dir)));
      const app = makeMemoryApplicationLayers({
        layerPersistence: SqlitePersistence.layerMemory,
        layerRepositoryIdentityResolver: Layer.mock(
          RepositoryIdentityResolver.RepositoryIdentityResolver,
        )({}),
        layerServerSettings: ServerSettings.layerTest({}, "memoryHub"),
        layerTextGeneration: Layer.mock(TextGeneration.TextGeneration)({}),
      });
      const administrator = yield* Effect.serviceOption(MemoryHub.MemoryHubAdministrator).pipe(
        Effect.provide(
          app.layerMemoryHubAdministrator.pipe(
            Layer.provideMerge(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      expect(administrator._tag).toBe("Some");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
