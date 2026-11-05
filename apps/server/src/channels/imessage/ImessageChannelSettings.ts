/**
 * Settings behind the `imessageChannel.*` RPCs: `<stateDir>/imessage-channel-settings.json`
 * holds whether iMessage is on and which handles are heard. `start` must run once at server start.
 */
import {
  ImessageChannelSettingsError,
  type ImessageChannelCheckAccessResult,
  type ImessageChannelConfigureInput,
  type ImessageChannelSettings as ImessageChannelSettingsSnapshot,
  type ImessageChannelSettingsErrorReason,
  type ImessageChannelStatusEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ImessageChannelRuntime from "./ImessageChannelRuntime.ts";
import { normalizeHandle } from "./imessageHandles.ts";

const StoredSettings = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  allowedHandles: Schema.Array(Schema.String),
  selfHandles: Schema.Array(Schema.String),
});
type StoredSettings = typeof StoredSettings.Type;

const StoredSettingsJson = Schema.fromJsonString(StoredSettings);
const decodeStored = Schema.decodeUnknownEffect(StoredSettingsJson);
const encodeStored = Schema.encodeEffect(StoredSettingsJson);

const SETTINGS_FILE_NAME = "imessage-channel-settings.json";
const EMPTY: StoredSettings = { version: 1, enabled: false, allowedHandles: [], selfHandles: [] };

const fail = (reason: ImessageChannelSettingsErrorReason, detail?: string) =>
  Effect.fail(
    new ImessageChannelSettingsError({ reason, ...(detail === undefined ? {} : { detail }) }),
  );

/** Normalizes every handle, drops repeats, and names the first one that is not a handle. */
const normalizeHandles = (raw: ReadonlyArray<string>) => {
  const out = new Set<string>();
  for (const value of raw) {
    const handle = normalizeHandle(value);
    if (handle === undefined) return fail("invalid_handle", value.trim().slice(0, 100));
    out.add(handle);
  }
  return Effect.succeed([...out]);
};

export class ImessageChannelSettings extends Context.Service<
  ImessageChannelSettings,
  {
    readonly get: Effect.Effect<ImessageChannelSettingsSnapshot, ImessageChannelSettingsError>;
    /** Omitted fields keep their value; the running channel follows the saved result. */
    readonly configure: (
      input: ImessageChannelConfigureInput,
    ) => Effect.Effect<ImessageChannelSettingsSnapshot, ImessageChannelSettingsError>;
    /** The current status first, then each change. */
    readonly streamStatus: Stream.Stream<ImessageChannelStatusEvent>;
    /** Whether the server can read Messages now, so the permission shows before enabling. */
    readonly checkAccess: Effect.Effect<ImessageChannelCheckAccessResult>;
    /** Brings the saved configuration up; failures are logged and leave iMessage off. */
    readonly start: Effect.Effect<void>;
  }
>()("t3/channels/imessage/ImessageChannelSettings") {}

export const make = Effect.fn("ImessageChannelSettings.make")(function* (
  options: { readonly platform?: NodeJS.Platform } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const runtime = yield* ImessageChannelRuntime.ImessageChannelRuntime;
  const settingsPath = path.join(config.stateDir, SETTINGS_FILE_NAME);
  const lock = yield* Semaphore.make(1);
  const supported = (options.platform ?? (yield* HostProcess.Platform)) === "darwin";

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
      Effect.logError("iMessage settings file could not be read; iMessage stays off.").pipe(
        Effect.as({ loadFailed: true, stored: EMPTY }),
      ),
    ),
  );
  const state = yield* Ref.make(loaded);

  const readStored = Effect.flatMap(Ref.get(state), (current) =>
    current.loadFailed ? fail("persistence_failed") : Effect.succeed(current.stored),
  );

  /** Writes a private temporary file and renames it over the settings file. */
  const save = Effect.fn("ImessageChannelSettings.save")(
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
    // Causes can carry paths, so only the stage is logged.
    Effect.catch(() =>
      Effect.logWarning("iMessage settings could not be saved.").pipe(
        Effect.andThen(fail("persistence_failed")),
      ),
    ),
  );

  const apply = (stored: StoredSettings) =>
    runtime.apply(
      stored.enabled && supported
        ? { allowedHandles: stored.allowedHandles, selfHandles: stored.selfHandles }
        : null,
    );

  const snapshot = Effect.fn("ImessageChannelSettings.snapshot")(function* (
    stored: StoredSettings,
  ) {
    const status = yield* runtime.status;
    return {
      enabled: stored.enabled,
      allowedHandles: stored.allowedHandles,
      selfHandles: stored.selfHandles,
      ...status,
    } satisfies ImessageChannelSettingsSnapshot;
  });

  const configure = (input: ImessageChannelConfigureInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* readStored;
        const allowedHandles = yield* normalizeHandles(
          input.allowedHandles ?? stored.allowedHandles,
        );
        const selfHandles = yield* normalizeHandles(input.selfHandles ?? stored.selfHandles);
        const enabled = input.enabled ?? stored.enabled;
        if (allowedHandles.some((handle) => selfHandles.includes(handle))) {
          return yield* fail("handles_overlap");
        }
        if (enabled && !supported) return yield* fail("adapter_unavailable");
        if (enabled && allowedHandles.length === 0 && selfHandles.length === 0) {
          return yield* fail("no_handles");
        }
        const next: StoredSettings = { version: 1, enabled, allowedHandles, selfHandles };
        yield* save(next);
        yield* apply(next);
        return yield* snapshot(next);
      }),
    );

  return ImessageChannelSettings.of({
    get: Effect.flatMap(readStored, snapshot),
    configure,
    streamStatus: runtime.streamStatus,
    checkAccess: Effect.map(runtime.checkAccess, (access) => ({ access })),
    start: lock.withPermits(1)(
      Effect.flatMap(readStored, apply).pipe(
        Effect.catch(() => Effect.logWarning("iMessage could not be started; it stays off.")),
      ),
    ),
  });
});

export const layer = Layer.effect(ImessageChannelSettings, make());
