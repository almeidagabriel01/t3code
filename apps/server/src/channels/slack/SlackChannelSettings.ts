/**
 * Settings behind the `slackChannel.*` RPCs. Tokens live only in the secret store; the rest is
 * in `<stateDir>/slack-channel-settings.json`. `start` must run once at server start.
 */
import {
  SlackChannelConnectionId,
  SlackChannelId,
  SlackChannelSettingsError,
  TrimmedNonEmptyString,
  type SlackChannelConfigureInput,
  type SlackChannelSettings as SlackChannelSettingsSnapshot,
  type SlackChannelSettingsErrorReason,
  type SlackChannelStatusEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import * as SlackSdk from "./SlackSdk.ts";

const StoredSettings = Schema.Struct({
  version: Schema.Literal(1),
  connectionId: SlackChannelConnectionId,
  enabled: Schema.Boolean,
  teamId: Schema.optional(TrimmedNonEmptyString),
  botUserId: Schema.optional(TrimmedNonEmptyString),
  allowedChannelIds: Schema.Array(SlackChannelId),
});
type StoredSettings = typeof StoredSettings.Type;

const StoredSettingsJson = Schema.fromJsonString(StoredSettings);
const decodeStored = Schema.decodeUnknownEffect(StoredSettingsJson);
const encodeStored = Schema.encodeEffect(StoredSettingsJson);

interface LoadedState {
  readonly loadFailed: boolean;
  readonly stored: StoredSettings;
}

const SETTINGS_FILE_NAME = "slack-channel-settings.json";

const appTokenSecretName = (connectionId: string) => `slack-${connectionId}-app-token`;
const botTokenSecretName = (connectionId: string) => `slack-${connectionId}-bot-token`;

const fail = (reason: SlackChannelSettingsErrorReason) =>
  Effect.fail(new SlackChannelSettingsError({ reason }));

/** Logs the failure by category only (causes can carry paths) and reports `persistence_failed`. */
const persistenceFailed = (stage: string) => (cause: unknown) =>
  Effect.logWarning("Slack settings could not be saved or read.").pipe(
    Effect.annotateLogs({
      stage,
      errorTag:
        typeof cause === "object" && cause !== null && "_tag" in cause
          ? String(cause._tag)
          : "unknown",
    }),
    Effect.andThen(fail("persistence_failed")),
  );

const tokenValidationFailed = (failure: SlackSdk.SlackSdkFailure) =>
  fail(
    failure.category === "auth_revoked" || failure.category === "auth_invalid"
      ? "invalid_token"
      : "adapter_unavailable",
  );

export class SlackChannelSettings extends Context.Service<
  SlackChannelSettings,
  {
    readonly get: Effect.Effect<SlackChannelSettingsSnapshot, SlackChannelSettingsError>;
    /** Omitted fields keep their value; tokens are checked with Slack before anything is stored. */
    readonly configure: (
      input: SlackChannelConfigureInput,
    ) => Effect.Effect<SlackChannelSettingsSnapshot, SlackChannelSettingsError>;
    /** Stops the connection and deletes both tokens. */
    readonly disconnect: Effect.Effect<SlackChannelSettingsSnapshot, SlackChannelSettingsError>;
    /** The current status first, then each change. */
    readonly streamStatus: Stream.Stream<SlackChannelStatusEvent, SlackChannelSettingsError>;
    /** Brings the saved connection up; failures are logged and leave Slack off. */
    readonly start: Effect.Effect<void>;
  }
>()("t3/channels/slack/SlackChannelSettings") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sdk = yield* SlackSdk.SlackSdk;
  const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
  const settingsPath = path.join(config.stateDir, SETTINGS_FILE_NAME);
  const lock = yield* Semaphore.make(1);

  const newConnectionId = crypto
    .randomUUIDv4()
    .pipe(
      Effect.map((uuid) =>
        SlackChannelConnectionId.make(`slack-${uuid.replaceAll("-", "").slice(0, 12)}`),
      ),
    );

  const fresh = (loadFailed: boolean): Effect.Effect<LoadedState> =>
    newConnectionId.pipe(
      Effect.orDie,
      Effect.map((connectionId) => ({
        loadFailed,
        stored: { version: 1, connectionId, enabled: false, allowedChannelIds: [] },
      })),
    );

  const loaded: LoadedState = yield* fs.exists(settingsPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.readFileString(settingsPath).pipe(
            Effect.flatMap(decodeStored),
            Effect.map((stored): LoadedState => ({ loadFailed: false, stored })),
          )
        : fresh(false),
    ),
    // Keep a damaged file as it is; every operation reports the failure until it is fixed.
    Effect.catch(() =>
      Effect.andThen(
        Effect.logError("Slack settings file could not be read; Slack stays off."),
        fresh(true),
      ),
    ),
  );
  const state = yield* Ref.make(loaded);

  const readStored = Effect.flatMap(Ref.get(state), (current) =>
    current.loadFailed ? fail("persistence_failed") : Effect.succeed(current.stored),
  );

  /** Writes a private temporary file and renames it over the settings file. */
  const save = Effect.fn("SlackChannelSettings.save")(
    function* (stored: StoredSettings) {
      const contents = yield* encodeStored(stored);
      const tempPath = `${settingsPath}.${yield* crypto.randomUUIDv4()}.tmp`;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(tempPath, `${contents}\n`, { mode: 0o600 });
        yield* fs.chmod(tempPath, 0o600);
        yield* fs.rename(tempPath, settingsPath);
      }).pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore)));
      yield* Ref.set(state, { loadFailed: false, stored });
    },
    Effect.catch(persistenceFailed("write-settings")),
  );

  const readSecret = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
        Effect.catch(persistenceFailed("read-secret")),
      );
  const writeSecret = (name: string, value: string) =>
    secrets
      .set(name, new TextEncoder().encode(value))
      .pipe(Effect.catch(persistenceFailed("write-secret")));
  const removeSecret = (name: string) =>
    secrets.remove(name).pipe(Effect.catch(persistenceFailed("remove-secret")));

  /** The runtime config when the connection is on and both tokens exist; otherwise nothing runs. */
  const runtimeConfig = Effect.fn("SlackChannelSettings.runtimeConfig")(function* (
    stored: StoredSettings,
  ) {
    if (!stored.enabled) return null;
    const appToken = yield* readSecret(appTokenSecretName(stored.connectionId));
    const botToken = yield* readSecret(botTokenSecretName(stored.connectionId));
    if (Option.isNone(appToken) || Option.isNone(botToken)) return null;
    return {
      connectionId: stored.connectionId,
      appToken: appToken.value,
      botToken: botToken.value,
      allowedChannelIds: stored.allowedChannelIds,
      expectedTeamId: stored.teamId,
    } satisfies SlackChannelRuntime.SlackConnectionConfig;
  });

  /** Saves the connection as disabled and stops it in one uninterruptible step. */
  const disable = (stored: StoredSettings) =>
    Effect.uninterruptible(
      save({ ...stored, enabled: false }).pipe(Effect.andThen(runtime.apply(null))),
    );

  const snapshot = Effect.fn("SlackChannelSettings.snapshot")(function* (stored: StoredSettings) {
    const status = yield* runtime.status;
    const hasAppToken = Option.isSome(yield* readSecret(appTokenSecretName(stored.connectionId)));
    const hasBotToken = Option.isSome(yield* readSecret(botTokenSecretName(stored.connectionId)));
    return {
      connectionId: stored.connectionId,
      enabled: stored.enabled,
      hasAppToken,
      hasBotToken,
      ...(stored.teamId === undefined ? {} : { teamId: stored.teamId }),
      ...(stored.botUserId === undefined ? {} : { botUserId: stored.botUserId }),
      allowedChannelIds: stored.allowedChannelIds,
      status: status.status,
      ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
      ...(status.lastDeliveryError === undefined
        ? {}
        : { lastDeliveryError: status.lastDeliveryError }),
    } satisfies SlackChannelSettingsSnapshot;
  });

  const clearCredentials = Effect.fn("SlackChannelSettings.clearCredentials")(function* (
    stored: StoredSettings,
  ) {
    yield* disable(stored);
    yield* removeSecret(appTokenSecretName(stored.connectionId));
    yield* removeSecret(botTokenSecretName(stored.connectionId));
    const { teamId: _teamId, botUserId: _botUserId, ...rest } = stored;
    const cleared: StoredSettings = { ...rest, enabled: false };
    yield* save(cleared);
    return yield* snapshot(cleared);
  });

  const configure = (input: SlackChannelConfigureInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* readStored;
        const { connectionId } = stored;
        const changesTokens = input.appToken !== undefined || input.botToken !== undefined;

        if (input.clearCredentials === true) {
          if (changesTokens) return yield* fail("invalid_input");
          return yield* clearCredentials(stored);
        }

        // Validate new tokens before anything is written.
        if (input.appToken !== undefined) {
          const appToken = input.appToken;
          yield* SlackSdk.slackCall("apps.connections.open", () =>
            sdk.appApi({ appToken }).openConnection(),
          ).pipe(Effect.catch(tokenValidationFailed));
        }
        let identity: SlackSdk.SlackAuthIdentity | undefined;
        if (input.botToken !== undefined) {
          const botToken = input.botToken;
          identity = yield* SlackSdk.slackCall("auth.test", () =>
            sdk.botApi({ botToken }).authTest(),
          ).pipe(Effect.catch(tokenValidationFailed));
        }

        const enabled = input.enabled ?? stored.enabled;
        if (enabled) {
          const hasAppToken =
            input.appToken !== undefined ||
            Option.isSome(yield* readSecret(appTokenSecretName(connectionId)));
          const hasBotToken =
            input.botToken !== undefined ||
            Option.isSome(yield* readSecret(botTokenSecretName(connectionId)));
          if (!hasAppToken || !hasBotToken) return yield* fail("invalid_input");
        }

        if (changesTokens) {
          yield* disable(stored);
          if (input.appToken !== undefined) {
            yield* writeSecret(appTokenSecretName(connectionId), input.appToken);
          }
          if (input.botToken !== undefined) {
            yield* writeSecret(botTokenSecretName(connectionId), input.botToken);
          }
        }

        const next: StoredSettings = {
          ...stored,
          enabled,
          ...(identity === undefined
            ? {}
            : { teamId: identity.teamId, botUserId: identity.botUserId }),
          allowedChannelIds: [...new Set(input.allowedChannelIds ?? stored.allowedChannelIds)],
        };
        if (enabled) {
          yield* save(next);
          yield* Effect.flatMap(runtimeConfig(next), runtime.apply);
        } else {
          yield* disable(next);
        }
        return yield* snapshot(next);
      }),
    );

  const statusEvents = runtime.streamStatus.pipe(
    Stream.mapEffect((status) =>
      Effect.map(readStored, (stored) => ({
        connectionId: stored.connectionId,
        status: status.status,
        ...(stored.teamId === undefined ? {} : { teamId: stored.teamId }),
        ...(stored.botUserId === undefined ? {} : { botUserId: stored.botUserId }),
        ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
        ...(status.lastDeliveryError === undefined
          ? {}
          : { lastDeliveryError: status.lastDeliveryError }),
      })),
    ),
  );

  return SlackChannelSettings.of({
    get: Effect.flatMap(readStored, snapshot),
    configure,
    disconnect: lock.withPermits(1)(Effect.flatMap(readStored, clearCredentials)),
    streamStatus: statusEvents,
    start: lock.withPermits(1)(
      Effect.flatMap(readStored, runtimeConfig).pipe(
        Effect.flatMap(runtime.apply),
        Effect.catch(() =>
          Effect.logWarning("Slack connection could not be started; Slack stays off."),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(SlackChannelSettings, make);
