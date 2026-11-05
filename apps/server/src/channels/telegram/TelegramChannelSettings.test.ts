import * as CryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { TelegramChannelSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as Runtime from "./TelegramChannelRuntime.ts";
import * as Settings from "./TelegramChannelSettings.ts";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_secret";
const OTHER_TOKEN = "654321:ZYXWVUTSRQPONMLKJIHGFEDCBA_other";

const harness = () => {
  const dismissed: Array<ReadonlyArray<string>> = [];
  const applied: Array<{ token: string; allowedUserIds: ReadonlyArray<string> } | null> = [];
  const runtime = Layer.succeed(
    Runtime.TelegramChannelRuntime,
    Runtime.TelegramChannelRuntime.of({
      apply: (config) =>
        Effect.sync(
          () =>
            void applied.push(
              config === null
                ? null
                : { token: Redacted.value(config.token), allowedUserIds: config.allowedUserIds },
            ),
        ),
      dismiss: (ids) => Effect.sync(() => void dismissed.push(ids)),
      status: Effect.succeed({ status: "running", botUsername: "my_bot" }),
      streamStatus: Stream.make({ status: "running" } as const),
      pollOnce: Effect.die("not polled"),
    }),
  );
  const layer = Layer.effect(Settings.TelegramChannelSettings, Settings.make()).pipe(
    Layer.provideMerge(Secrets.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-telegram-settings-" })),
    Layer.provideMerge(runtime),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, CryptoLayer.layer)),
  );
  return { applied, dismissed, layer };
};

const reason = <A>(effect: Effect.Effect<A, TelegramChannelSettingsError>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    return Option.isSome(error) ? error.value : undefined;
  });

const settingsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return path.join(config.stateDir, "telegram-channel-settings.json");
});

it.effect("starts off with no token, and shows the runtime status over it", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.TelegramChannelSettings;
    assert.deepStrictEqual(yield* settings.get, {
      enabled: false,
      tokenConfigured: false,
      allowedUserIds: [],
      status: "running",
      botUsername: "my_bot",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("keeps the token in the secret store only, and never hands it back", () => {
  const { applied, layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.TelegramChannelSettings;
    const secrets = yield* Secrets.ServerSecretStore;
    const fs = yield* FileSystem.FileSystem;
    const result = yield* settings.configure({
      enabled: true,
      botToken: ` ${TOKEN} `,
      allowedUserIds: [" 111 ", "111", "222"],
    });
    assert.deepStrictEqual(result.allowedUserIds, ["111", "222"]);
    assert.deepStrictEqual([result.enabled, result.tokenConfigured], [true, true]);
    assert.isFalse(JSON.stringify(result).includes("secret"));
    assert.deepStrictEqual(applied.at(-1), { token: TOKEN, allowedUserIds: ["111", "222"] });

    const stored = yield* secrets.get(Settings.TELEGRAM_TOKEN_SECRET);
    assert.strictEqual(new TextDecoder().decode(Option.getOrThrow(stored)), TOKEN);
    const file = yield* settingsFile;
    const text = yield* fs.readFileString(file);
    assert.isFalse(text.includes("secret"));
    assert.deepStrictEqual(JSON.parse(text), {
      version: 1,
      enabled: true,
      allowedUserIds: ["111", "222"],
    });
    assert.strictEqual(((yield* fs.stat(file)).mode & 0o777).toString(8), "600");
    assert.deepStrictEqual(yield* settings.get, result);

    // Other fields keep their value; a new token replaces the old one and restarts with it.
    yield* settings.configure({ botToken: OTHER_TOKEN });
    assert.deepStrictEqual(applied.at(-1), { token: OTHER_TOKEN, allowedUserIds: ["111", "222"] });
    yield* settings.configure({ enabled: false });
    assert.isNull(applied.at(-1));
    assert.isTrue((yield* settings.get).tokenConfigured);
  }).pipe(Effect.provide(layer));
});

it.effect("turns on with only a token, and passes dismissed senders to the runtime", () => {
  const { applied, dismissed, layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.TelegramChannelSettings;
    const result = yield* settings.configure({ enabled: true, botToken: TOKEN });
    assert.deepStrictEqual([result.enabled, result.allowedUserIds], [true, []]);
    assert.deepStrictEqual(applied.at(-1), { token: TOKEN, allowedUserIds: [] });
    yield* settings.configure({ dismissUserIds: ["555"] });
    assert.deepStrictEqual(dismissed, [["555"]]);
  }).pipe(Effect.provide(layer));
});

it.effect("clearing the token removes it and turns Telegram off", () => {
  const { applied, layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.TelegramChannelSettings;
    const secrets = yield* Secrets.ServerSecretStore;
    yield* settings.configure({ enabled: true, botToken: TOKEN, allowedUserIds: ["111"] });
    const cleared = yield* settings.configure({ clearToken: true });
    assert.deepStrictEqual([cleared.enabled, cleared.tokenConfigured], [false, false]);
    assert.isNull(applied.at(-1));
    assert.isTrue(Option.isNone(yield* secrets.get(Settings.TELEGRAM_TOKEN_SECRET)));
    // A new token in the same call wins over clearing.
    const replaced = yield* settings.configure({ clearToken: true, botToken: TOKEN });
    assert.isTrue(replaced.tokenConfigured);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses what cannot work, without saving or applying anything", () => {
  const { applied, layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.TelegramChannelSettings;
    assert.strictEqual((yield* reason(settings.configure({ enabled: true })))?.reason, "no_token");
    const badToken = yield* reason(settings.configure({ botToken: "not-a-token secret" }));
    assert.strictEqual(badToken?.reason, "invalid_token");
    assert.isUndefined(badToken?.detail);
    for (const id of ["abc", "0", "-5", "12.5", "@name", "1".repeat(16), ""]) {
      const error = yield* reason(settings.configure({ allowedUserIds: [id] }));
      assert.deepStrictEqual([error?.reason, error?.detail], ["invalid_user_id", id]);
    }
    assert.lengthOf(applied, 0);
    assert.isFalse((yield* settings.get).tokenConfigured);
    const fs = yield* FileSystem.FileSystem;
    assert.isFalse(yield* fs.exists(yield* settingsFile));
  }).pipe(Effect.provide(layer));
});

it.effect("brings the saved configuration up at start, and stays off when it cannot", () => {
  const { applied, layer } = harness();
  return Effect.gen(function* () {
    const settings = yield* Settings.TelegramChannelSettings;
    const secrets = yield* Secrets.ServerSecretStore;
    const fs = yield* FileSystem.FileSystem;
    yield* settings.start;
    assert.isNull(applied.at(-1));

    yield* settings.configure({ enabled: true, botToken: TOKEN, allowedUserIds: ["111"] });
    applied.length = 0;
    yield* settings.start;
    assert.deepStrictEqual(applied, [{ token: TOKEN, allowedUserIds: ["111"] }]);

    // Enabled on disk but the secret is gone: off, not a crash.
    yield* secrets.remove(Settings.TELEGRAM_TOKEN_SECRET);
    yield* settings.start;
    assert.isNull(applied.at(-1));

    // A damaged file is kept as it is and every operation says so.
    const file = yield* settingsFile;
    yield* fs.writeFileString(file, "{ not json");
    const reloaded = yield* Settings.make();
    const damaged = yield* reason(reloaded.get);
    assert.strictEqual(damaged?.reason, "persistence_failed");
    assert.strictEqual(yield* fs.readFileString(file), "{ not json");
  }).pipe(Effect.provide(layer));
});
