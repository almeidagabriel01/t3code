import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { SlackChannelSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { makeFakeSlackSdk, type FakeSlackSdk } from "./slackSdkFake.ts";
import { SlackSdkFailure } from "./SlackSdk.ts";

const APP_TOKEN = "xapp-1-SENTINEL-app";
const BOT_TOKEN = "xoxb-SENTINEL-bot";
const CHANNEL = "C0000000001";

const harness = () => {
  const sdk = makeFakeSlackSdk();
  const applied: Array<SlackChannelRuntime.SlackConnectionConfig | null> = [];
  const runtimeStatus: SlackChannelRuntime.SlackRuntimeStatus = { status: "disabled" };
  const runtime = Layer.succeed(
    SlackChannelRuntime.SlackChannelRuntime,
    SlackChannelRuntime.SlackChannelRuntime.of({
      apply: (config) => Effect.sync(() => void applied.push(config)),
      status: Effect.succeed(runtimeStatus),
      streamStatus: Stream.make(runtimeStatus, {
        status: "error",
        lastError: "token_revoked",
      } as const),
    }),
  );
  const layer = SlackChannelSettings.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-slack-settings-" })),
    Layer.provideMerge(Layer.mergeAll(sdk.layer, runtime)),
    Layer.provideMerge(NodeServices.layer),
  );
  return { sdk, applied, layer };
};

const failWith = (sdk: FakeSlackSdk, operation: "auth.test" | "apps.connections.open") => {
  const failure = new SlackSdkFailure({ operation, category: "auth_invalid" });
  if (operation === "auth.test") sdk.script.authTest = () => Promise.reject(failure);
  else sdk.script.openConnection = () => Promise.reject(failure);
};

const secret = (name: string) =>
  Effect.flatMap(ServerSecretStore.ServerSecretStore, (store) => store.get(name)).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
  );

const reason = <A>(effect: Effect.Effect<A, SlackChannelSettingsError>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    return Option.isSome(error) ? error.value : undefined;
  });

describe("SlackChannelSettings", () => {
  it.effect("validates and stores tokens, then applies the enabled config", () => {
    const { applied, layer } = harness();
    return Effect.gen(function* () {
      const settings = yield* SlackChannelSettings.SlackChannelSettings;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const result = yield* settings.configure({
        enabled: true,
        appToken: APP_TOKEN,
        botToken: BOT_TOKEN,
        allowedChannelIds: [CHANNEL, CHANNEL],
      });
      assert.match(result.connectionId, /^slack-[a-f0-9]{12}$/);
      assert.deepStrictEqual(
        { ...result, connectionId: undefined },
        {
          connectionId: undefined,
          enabled: true,
          hasAppToken: true,
          hasBotToken: true,
          teamId: "T0000000001",
          botUserId: "U0000000002",
          allowedChannelIds: [CHANNEL],
          status: "disabled",
        },
      );
      assert.isFalse(JSON.stringify(result).includes("SENTINEL"));
      assert.deepStrictEqual(applied.at(-1), {
        connectionId: result.connectionId,
        appToken: APP_TOKEN,
        botToken: BOT_TOKEN,
        allowedChannelIds: [CHANNEL],
        expectedTeamId: "T0000000001",
      });
      // Disabled first, so a crash between steps never leaves a running half state.
      assert.deepStrictEqual(applied.slice(0, -1), [null]);

      const file = path.join(config.stateDir, "slack-channel-settings.json");
      assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
      const raw = yield* fs.readFileString(file);
      assert.isFalse(raw.includes("SENTINEL"));
      assert.strictEqual(JSON.parse(raw).version, 1);
      assert.deepStrictEqual(
        (yield* fs.readDirectory(config.stateDir)).filter((name) => name.endsWith(".tmp")),
        [],
      );
      assert.deepStrictEqual(
        yield* secret(`slack-${result.connectionId}-bot-token`),
        Option.some(BOT_TOKEN),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("stores nothing when Slack rejects a token", () => {
    const { sdk, applied, layer } = harness();
    return Effect.gen(function* () {
      const settings = yield* SlackChannelSettings.SlackChannelSettings;
      const before = yield* settings.get;
      failWith(sdk, "auth.test");
      const error = yield* reason(
        settings.configure({ enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN }),
      );
      assert.strictEqual(error?.reason, "invalid_token");
      assert.isFalse(String(error?.message).includes("SENTINEL"));
      failWith(sdk, "apps.connections.open");
      const appError = yield* reason(settings.configure({ appToken: APP_TOKEN }));
      assert.strictEqual(appError?.reason, "invalid_token");
      sdk.script.openConnection = () =>
        Promise.reject(
          new SlackSdkFailure({ operation: "apps.connections.open", category: "network" }),
        );
      const down = yield* reason(settings.configure({ appToken: APP_TOKEN }));
      assert.strictEqual(down?.reason, "adapter_unavailable");
      assert.deepStrictEqual(yield* settings.get, before);
      assert.deepStrictEqual(
        yield* secret(`slack-${before.connectionId}-app-token`),
        Option.none(),
      );
      assert.deepStrictEqual(applied, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps stored tokens when omitted and rejects enabling without both", () => {
    const { applied, layer } = harness();
    return Effect.gen(function* () {
      const settings = yield* SlackChannelSettings.SlackChannelSettings;
      const missing = yield* reason(settings.configure({ enabled: true, appToken: APP_TOKEN }));
      assert.strictEqual(missing?.reason, "invalid_input");
      yield* settings.configure({ appToken: APP_TOKEN, botToken: BOT_TOKEN });
      assert.deepStrictEqual(applied.at(-1), null);
      const enabled = yield* settings.configure({ enabled: true, allowedChannelIds: [CHANNEL] });
      assert.isTrue(enabled.hasAppToken && enabled.hasBotToken);
      assert.strictEqual(applied.at(-1)?.appToken, APP_TOKEN);
      const rotated = yield* settings.configure({ botToken: "xoxb-SENTINEL-new" });
      assert.strictEqual(rotated.enabled, true);
      assert.strictEqual(applied.at(-1)?.botToken, "xoxb-SENTINEL-new");
      assert.strictEqual(applied.at(-1)?.appToken, APP_TOKEN);
      const off = yield* settings.configure({ enabled: false });
      assert.isFalse(off.enabled);
      assert.isTrue(off.hasBotToken);
      assert.strictEqual(applied.at(-1), null);
    }).pipe(Effect.provide(layer));
  });

  it.effect("disconnect and clearCredentials delete both tokens and stop", () => {
    const { applied, layer } = harness();
    return Effect.gen(function* () {
      const settings = yield* SlackChannelSettings.SlackChannelSettings;
      const first = yield* settings.configure({
        enabled: true,
        appToken: APP_TOKEN,
        botToken: BOT_TOKEN,
      });
      const disconnected = yield* settings.disconnect;
      assert.deepStrictEqual(
        {
          enabled: disconnected.enabled,
          app: disconnected.hasAppToken,
          bot: disconnected.hasBotToken,
        },
        { enabled: false, app: false, bot: false },
      );
      assert.isUndefined(disconnected.teamId);
      assert.strictEqual(applied.at(-1), null);
      assert.deepStrictEqual(yield* secret(`slack-${first.connectionId}-app-token`), Option.none());
      yield* settings.configure({ enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN });
      const cleared = yield* settings.configure({ clearCredentials: true });
      assert.isFalse(cleared.hasAppToken);
      const conflict = yield* reason(
        settings.configure({ clearCredentials: true, appToken: APP_TOKEN }),
      );
      assert.strictEqual(conflict?.reason, "invalid_input");
      assert.strictEqual(cleared.connectionId, first.connectionId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("start applies the stored config after a restart, and nothing when off", () => {
    const { applied, layer } = harness();
    return Effect.gen(function* () {
      const settings = yield* SlackChannelSettings.SlackChannelSettings;
      yield* settings.start;
      assert.deepStrictEqual(applied, [null]);
      const configured = yield* settings.configure({
        enabled: true,
        appToken: APP_TOKEN,
        botToken: BOT_TOKEN,
      });
      // A second service over the same state dir and secrets is a server restart.
      const restarted = yield* SlackChannelSettings.make;
      assert.strictEqual((yield* restarted.get).connectionId, configured.connectionId);
      applied.length = 0;
      yield* restarted.start;
      assert.strictEqual(applied[0]?.connectionId, configured.connectionId);
      assert.strictEqual(applied[0]?.botToken, BOT_TOKEN);
      const events = yield* Stream.runCollect(restarted.streamStatus);
      assert.deepStrictEqual(
        events.map((e) => [e.connectionId, e.status, e.lastError]),
        [
          [configured.connectionId, "disabled", undefined],
          [configured.connectionId, "error", "token_revoked"],
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("a damaged settings file keeps Slack off and reports persistence_failed", () => {
    const { applied, layer } = harness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(config.stateDir, "slack-channel-settings.json"), "{nope");
      const settings = yield* SlackChannelSettings.make;
      assert.strictEqual((yield* reason(settings.get))?.reason, "persistence_failed");
      assert.strictEqual(
        (yield* reason(settings.configure({ allowedChannelIds: [] })))?.reason,
        "persistence_failed",
      );
      yield* settings.start;
      assert.deepStrictEqual(applied, []);
    }).pipe(Effect.provide(layer));
  });
});
