/**
 * Settings behind the `telegramChannel.*` RPCs. `<stateDir>/telegram-channel-settings.json` holds
 * whether Telegram is on and which user ids are heard; unknown senders wait in memory for approval; the bot token is a secret and lives in the
 * server secret store, never in that file and never in a reply. `start` must run once at server start.
 */
import {
  TelegramChannelSettingsError,
  type TelegramChannelConfigureInput,
  type TelegramChannelSettings as TelegramChannelSettingsSnapshot,
  type TelegramChannelSettingsErrorReason,
  type TelegramChannelStatusEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";

import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as TelegramChannelRuntime from "./TelegramChannelRuntime.ts";

const StoredSettings = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  allowedUserIds: Schema.Array(Schema.String),
});
type StoredSettings = typeof StoredSettings.Type;

const StoredSettingsJson = Schema.fromJsonString(StoredSettings);
const decodeStored = Schema.decodeUnknownEffect(StoredSettingsJson);
const encodeStored = Schema.encodeEffect(StoredSettingsJson);

const SETTINGS_FILE_NAME = "telegram-channel-settings.json";
export const TELEGRAM_TOKEN_SECRET = "telegram-bot-token";
const EMPTY: StoredSettings = { version: 1, enabled: false, allowedUserIds: [] };
/** `<bot id>:<secret>`, as BotFather hands it out. */
const TOKEN_PATTERN = /^\d{4,}:[A-Za-z0-9_-]{20,}$/;
/** Telegram user ids are positive integers that fit in 52 bits. */
const USER_ID_PATTERN = /^[1-9]\d{0,14}$/;

const fail = (reason: TelegramChannelSettingsErrorReason, detail?: string) =>
  Effect.fail(
    new TelegramChannelSettingsError({ reason, ...(detail === undefined ? {} : { detail }) }),
  );

const normalizeUserIds = (raw: ReadonlyArray<string>) => {
  const out = new Set<string>();
  for (const value of raw) {
    const id = value.trim();
    if (!USER_ID_PATTERN.test(id)) return fail("invalid_user_id", id.slice(0, 30));
    out.add(id);
  }
  return Effect.succeed([...out]);
};

export class TelegramChannelSettings extends Context.Service<
  TelegramChannelSettings,
  {
    readonly get: Effect.Effect<TelegramChannelSettingsSnapshot, TelegramChannelSettingsError>;
    /** Omitted fields keep their value; the running channel follows the saved result. */
    readonly configure: (
      input: TelegramChannelConfigureInput,
    ) => Effect.Effect<TelegramChannelSettingsSnapshot, TelegramChannelSettingsError>;
    /** The current status first, then each change. */
    readonly streamStatus: Stream.Stream<TelegramChannelStatusEvent>;
    /** Brings the saved configuration up; failures are logged and leave Telegram off. */
    readonly start: Effect.Effect<void>;
  }
>()("t3/channels/telegram/TelegramChannelSettings") {}

export const make = Effect.fn("TelegramChannelSettings.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* Secrets.ServerSecretStore;
  const runtime = yield* TelegramChannelRuntime.TelegramChannelRuntime;
  const settingsPath = path.join(config.stateDir, SETTINGS_FILE_NAME);
  const lock = yield* Semaphore.make(1);

  const loaded = yield* fs.exists(settingsPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.readFileString(settingsPath).pipe(
            Effect.flatMap(decodeStored),
            Effect.map((stored) => ({ loadFailed: false, stored })),
          )
        : Effect.succeed({ loadFailed: false, stored: EMPTY }),
    ),
    // Keep a damaged file as it is; every operation reports the failure until it is fixed.
    Effect.catch(() =>
      Effect.logError("Telegram settings file could not be read; Telegram stays off.").pipe(
        Effect.as({ loadFailed: true, stored: EMPTY }),
      ),
    ),
  );
  const state = yield* Ref.make(loaded);

  const readStored = Effect.flatMap(Ref.get(state), (current) =>
    current.loadFailed ? fail("persistence_failed") : Effect.succeed(current.stored),
  );

  // Errors from the secret store name the secret; only the stage is logged.
  const secretFailure = <A>(effect: Effect.Effect<A, Secrets.SecretStoreError>) =>
    effect.pipe(
      Effect.catch(() =>
        Effect.logWarning("Telegram bot token could not be read or saved.").pipe(
          Effect.andThen(fail("persistence_failed")),
        ),
      ),
    );

  const readToken = secretFailure(secrets.get(TELEGRAM_TOKEN_SECRET)).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
  );

  /** Writes a private temporary file and renames it over the settings file. */
  const save = Effect.fn("TelegramChannelSettings.save")(
    function* (stored: StoredSettings) {
      const contents = yield* encodeStored(stored);
      const tempPath = `${settingsPath}.${yield* random.uuidV4()}.tmp`;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(tempPath, `${contents}\n`, { mode: 0o600 });
        yield* fs.chmod(tempPath, 0o600);
        yield* fs.rename(tempPath, settingsPath);
      }).pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore)));
      yield* Ref.set(state, { loadFailed: false, stored });
    },
    Effect.catch(() =>
      Effect.logWarning("Telegram settings could not be saved.").pipe(
        Effect.andThen(fail("persistence_failed")),
      ),
    ),
  );

  const apply = (stored: StoredSettings, token: Option.Option<string>) =>
    runtime.apply(
      stored.enabled && Option.isSome(token)
        ? { token: Redacted.make(token.value), allowedUserIds: stored.allowedUserIds }
        : null,
    );

  const snapshot = Effect.fn("TelegramChannelSettings.snapshot")(function* (
    stored: StoredSettings,
    token: Option.Option<string>,
  ) {
    const status = yield* runtime.status;
    return {
      enabled: stored.enabled,
      tokenConfigured: Option.isSome(token),
      allowedUserIds: stored.allowedUserIds,
      ...status,
    } satisfies TelegramChannelSettingsSnapshot;
  });

  const configure = (input: TelegramChannelConfigureInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* readStored;
        const allowedUserIds = yield* normalizeUserIds(
          input.allowedUserIds ?? stored.allowedUserIds,
        );
        const newToken = input.botToken?.trim();
        if (newToken !== undefined && !TOKEN_PATTERN.test(newToken)) {
          return yield* fail("invalid_token");
        }
        const clearing = input.clearToken === true && newToken === undefined;
        const token: Option.Option<string> =
          newToken !== undefined
            ? Option.some(newToken)
            : clearing
              ? Option.none()
              : yield* readToken;
        // Without a token the channel cannot run, so clearing it also turns Telegram off.
        const enabled = clearing ? false : (input.enabled ?? stored.enabled);
        if (enabled && Option.isNone(token)) return yield* fail("no_token");
        if (newToken !== undefined) {
          yield* secretFailure(
            secrets.set(TELEGRAM_TOKEN_SECRET, new TextEncoder().encode(newToken)),
          );
        } else if (clearing) {
          yield* secretFailure(secrets.remove(TELEGRAM_TOKEN_SECRET));
        }
        const next: StoredSettings = { version: 1, enabled, allowedUserIds };
        yield* save(next);
        if (input.dismissUserIds !== undefined) yield* runtime.dismiss(input.dismissUserIds);
        yield* apply(next, token);
        return yield* snapshot(next, token);
      }),
    );

  return TelegramChannelSettings.of({
    get: Effect.gen(function* () {
      const stored = yield* readStored;
      return yield* snapshot(stored, yield* readToken);
    }),
    configure,
    streamStatus: runtime.streamStatus,
    start: lock.withPermits(1)(
      Effect.gen(function* () {
        yield* apply(yield* readStored, yield* readToken);
      }).pipe(
        Effect.catch(() => Effect.logWarning("Telegram could not be started; it stays off.")),
      ),
    ),
  });
});

export const layer = Layer.effect(TelegramChannelSettings, make());
