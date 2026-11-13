import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerConcurrentReadMissFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "readFile",
                    pathOrDescriptor: String(path),
                    description: "Secret file does not exist yet.",
                  });
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ServerSecretStore.layer", (it) => {
  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );
});

const layerCountingFileSystem = (options: {
  readonly reads: Ref.Ref<number>;
  readonly events: Queue.Queue<string>;
  readonly watchFails?: boolean;
}) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return {
        ...fileSystem,
        readFile: (path) =>
          Ref.update(options.reads, (count) => count + 1).pipe(
            Effect.andThen(fileSystem.readFile(path)),
          ),
        watch: (path, watchOptions) =>
          options.watchFails
            ? Stream.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "watch",
                  pathOrDescriptor: String(path),
                }),
              )
            : fileSystem
                .watch(path, watchOptions)
                .pipe(Stream.tap((event) => Queue.offer(options.events, event.path))),
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerCountingSecretStore = (options: Parameters<typeof layerCountingFileSystem>[0]) =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerCountingFileSystem(options)),
  );

const countingEnv = Effect.gen(function* () {
  return { reads: yield* Ref.make(0), events: yield* Queue.unbounded<string>() };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ServerSecretStore cache", (it) => {
  it.effect("serves repeated gets from memory and sees its own writes", () =>
    Effect.gen(function* () {
      const env = yield* countingEnv;
      yield* Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;
        assert.isTrue(Option.isNone(yield* store.get("a")));
        assert.isTrue(Option.isNone(yield* store.get("a")));
        assert.equal(yield* Ref.get(env.reads), 1);

        yield* store.set("a", Uint8Array.from([1, 2]));
        const first = Option.getOrThrow(yield* store.get("a"));
        first[0] = 9;
        assert.deepEqual(Array.from(Option.getOrThrow(yield* store.get("a"))), [1, 2]);

        yield* store.remove("a");
        assert.isTrue(Option.isNone(yield* store.get("a")));
      }).pipe(Effect.provide(layerCountingSecretStore(env)));
    }),
  );

  it.effect("sees a file written outside the store after the watcher reports it", () =>
    Effect.gen(function* () {
      const env = yield* countingEnv;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;
        const dir = store.directory;
        assert.isTrue(Option.isNone(yield* store.get("ext")));
        // Rename publishes the file atomically, so the single event cannot precede its content.
        const tmp = `${dir}/ext.stage`;
        yield* fileSystem.writeFile(tmp, Uint8Array.from([7]));
        yield* fileSystem.rename(tmp, `${dir}/ext.bin`);
        while ((yield* Queue.take(env.events)) !== "ext.bin") {
          // drain until the watcher reports the published file
        }
        assert.deepEqual(Array.from(Option.getOrThrow(yield* store.get("ext"))), [7]);
      }).pipe(Effect.provide(layerCountingSecretStore(env)));
    }),
  );

  it.effect("reads from disk every time when the watcher cannot start", () =>
    Effect.gen(function* () {
      const env = { ...(yield* countingEnv), watchFails: true };
      yield* Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;
        yield* store.get("a");
        yield* store.get("a");
        assert.equal(yield* Ref.get(env.reads), 2);
      }).pipe(Effect.provide(layerCountingSecretStore(env)));
    }),
  );
});
