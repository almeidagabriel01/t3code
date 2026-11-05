import * as CryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ImessageChannelAccess, ImessageChannelSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as Runtime from "./ImessageChannelRuntime.ts";
import * as Settings from "./ImessageChannelSettings.ts";

const FRIEND = "+15550000001";
const ME = "+15550000002";

const harness = (platform: NodeJS.Platform = "darwin") => {
  const applied: Array<Runtime.ImessageConfig | null> = [];
  const state = { access: "ok" as ImessageChannelAccess };
  const runtime = Layer.succeed(
    Runtime.ImessageChannelRuntime,
    Runtime.ImessageChannelRuntime.of({
      apply: (config) => Effect.sync(() => void applied.push(config)),
      status: Effect.succeed({ status: "error", lastError: "full_disk_access_missing" }),
      streamStatus: Stream.make({ status: "running" } as const),
      checkAccess: Effect.sync(() => ({ access: state.access, ownHandles: [] })),
      pollOnce: Effect.void,
    }),
  );
  const layer = Layer.effect(Settings.ImessageChannelSettings, Settings.make({ platform })).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-imessage-settings-" })),
    Layer.provideMerge(runtime),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, CryptoLayer.layer)),
  );
  return { applied, state, layer };
};

const reason = <A>(effect: Effect.Effect<A, ImessageChannelSettingsError>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    return Option.isSome(error) ? error.value : undefined;
  });

const settingsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return path.join(config.stateDir, "imessage-channel-settings.json");
});

it.effect("starts off and empty, with the runtime status laid over it", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.ImessageChannelSettings;
    assert.deepStrictEqual(yield* settings.get, {
      enabled: false,
      allowedHandles: [],
      selfHandles: [],
      status: "error",
      lastError: "full_disk_access_missing",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("normalizes handles, saves privately and atomically, and applies the result", () => {
  const { applied, layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.ImessageChannelSettings;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* settingsFile;
    const result = yield* settings.configure({
      enabled: true,
      allowedHandles: [" +1 (555) 000-0001 ", FRIEND, "Friend@Example.com"],
      selfHandles: [ME],
    });
    assert.deepStrictEqual(result.allowedHandles, [FRIEND, "friend@example.com"]);
    assert.deepStrictEqual(result.selfHandles, [ME]);
    assert.isTrue(result.enabled);
    assert.deepStrictEqual(applied, [
      { allowedHandles: [FRIEND, "friend@example.com"], selfHandles: [ME] },
    ]);
    assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(file)), {
      version: 1,
      enabled: true,
      allowedHandles: [FRIEND, "friend@example.com"],
      selfHandles: [ME],
    });
    const leftovers = (yield* fs.readDirectory(path.dirname(file))).filter((name) =>
      name.endsWith(".tmp"),
    );
    assert.deepStrictEqual(leftovers, []);

    // Omitted fields keep their value; turning it off stops the runtime.
    const off = yield* settings.configure({ enabled: false });
    assert.deepStrictEqual([off.enabled, off.allowedHandles.length], [false, 2]);
    assert.deepStrictEqual(applied.at(-1), null);
    const replaced = yield* settings.configure({ selfHandles: [] });
    assert.deepStrictEqual([replaced.allowedHandles.length, replaced.selfHandles], [2, []]);
  }).pipe(Effect.provide(layer));
});

const rejected: ReadonlyArray<{
  readonly name: string;
  readonly input: Parameters<Settings.ImessageChannelSettings["Service"]["configure"]>[0];
  readonly reason: string;
  readonly detail?: string;
}> = [
  {
    name: "a number without a country code",
    input: { allowedHandles: ["5550000001"] },
    reason: "invalid_handle",
    detail: "5550000001",
  },
  {
    name: "an invalid own handle",
    input: { selfHandles: ["me@"] },
    reason: "invalid_handle",
    detail: "me@",
  },
  {
    name: "a handle in both lists",
    input: { allowedHandles: [FRIEND], selfHandles: ["+1 555 000 0001"] },
    reason: "handles_overlap",
  },
  { name: "enabling with no handles", input: { enabled: true }, reason: "no_handles" },
];
it.effect.each(rejected)("rejects $name and stores nothing", (row) => {
  const { applied, layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.ImessageChannelSettings;
    const fs = yield* FileSystem.FileSystem;
    const error = yield* reason(settings.configure(row.input));
    assert.strictEqual(error?.reason, row.reason);
    assert.strictEqual(error?.detail, row.detail);
    assert.isTrue(error!.message.length > 0);
    assert.isFalse(yield* fs.exists(yield* settingsFile));
    assert.deepStrictEqual(applied, []);
  }).pipe(Effect.provide(layer));
});

it.effect("away from a Mac it refuses to turn on and applies nothing", () => {
  const { applied, layer } = harness("linux");
  return Effect.gen(function* () {
    const settings = yield* Settings.ImessageChannelSettings;
    assert.strictEqual(
      (yield* reason(settings.configure({ enabled: true, allowedHandles: [FRIEND] })))?.reason,
      "adapter_unavailable",
    );
    yield* settings.configure({ allowedHandles: [FRIEND] });
    yield* settings.start;
    assert.deepStrictEqual(applied.at(-1), null);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "start applies the stored configuration; a damaged file keeps it off and reports it",
  () => {
    const { applied, layer } = harness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const file = yield* settingsFile;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(
        file,
        JSON.stringify({ version: 1, enabled: true, allowedHandles: [FRIEND], selfHandles: [] }),
      );
      // Built after the file exists, so it loads it as a restarted server would.
      const settings = yield* Settings.make({ platform: "darwin" });
      yield* settings.start;
      assert.deepStrictEqual(applied, [{ allowedHandles: [FRIEND], selfHandles: [] }]);

      yield* fs.writeFileString(file, "{ not json");
      const damaged = yield* Settings.make({ platform: "darwin" });
      assert.strictEqual((yield* reason(damaged.get))?.reason, "persistence_failed");
      assert.strictEqual(
        (yield* reason(damaged.configure({ enabled: false })))?.reason,
        "persistence_failed",
      );
      yield* damaged.start;
      assert.lengthOf(applied, 1);
      assert.strictEqual(yield* fs.readFileString(file), "{ not json");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a failed save is reported and leaves the running channel alone", () => {
  const { applied, layer } = harness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const settings = yield* Settings.ImessageChannelSettings;
    const file = yield* settingsFile;
    // A directory where the file belongs makes the final rename fail.
    yield* fs.makeDirectory(file, { recursive: true });
    assert.strictEqual(
      (yield* reason(settings.configure({ enabled: true, allowedHandles: [FRIEND] })))?.reason,
      "persistence_failed",
    );
    assert.deepStrictEqual(applied, []);
  }).pipe(Effect.provide(layer));
});

it.effect("checkAccess and the status stream come from the runtime", () => {
  const { state, layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.ImessageChannelSettings;
    assert.deepStrictEqual(yield* settings.checkAccess, { access: "ok", ownHandles: [] });
    state.access = "full_disk_access_missing";
    assert.deepStrictEqual(yield* settings.checkAccess, {
      access: "full_disk_access_missing",
      ownHandles: [],
    });
    assert.deepStrictEqual(yield* Stream.runCollect(settings.streamStatus), [
      { status: "running" },
    ]);
  }).pipe(Effect.provide(layer));
});
