import {
  VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
  uint8ArrayToBase64,
  validateCanonicalVoiceWav,
  type ProviderInstanceId,
  type ThreadId,
  type VoicePrewarmInput,
  type VoiceTranscriptionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
} from "./transcription.ts";

const VOICE_TRANSCRIBE_TIMEOUT_MS = 120_000;
const VOICE_PREWARM_TIMEOUT_MS = 10_000;

export interface EnvironmentVoiceRequestContext {
  readonly prepared: PreparedConnection;
  readonly signer?: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}

/** Reads the signer and remote authorization the connection runtime already provides. */
export const resolveEnvironmentVoiceContext = Effect.fn("voice.resolveEnvironmentVoiceContext")(
  function* (prepared: PreparedConnection) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return { prepared, signer, remoteAuthorization } satisfies EnvironmentVoiceRequestContext;
  },
);

const requestAuth = (context: EnvironmentVoiceRequestContext) => ({
  prepared: context.prepared,
  signer: context.signer ?? Option.none(),
  ...(context.remoteAuthorization ? { remoteAuthorization: context.remoteAuthorization } : {}),
  method: "POST" as const,
  group: "voice" as const,
});

const remoteHttpClientLayer = layerRemoteHttpClient((input, init) =>
  Reflect.get(globalThis, "fetch")(input, init),
);

const transcribeEnvironmentVoice = (
  context: EnvironmentVoiceRequestContext,
  payload: VoiceTranscriptionInput,
  signal?: AbortSignal,
) =>
  Effect.runPromise(
    executeAuthenticatedEnvironmentHttpRequest({
      ...requestAuth(context),
      timeoutMs: VOICE_TRANSCRIBE_TIMEOUT_MS,
      url: (urls) => urls.transcribe(),
      request: ({ client, headers }) => client.transcribe({ headers, payload }),
    }).pipe(Effect.provide(remoteHttpClientLayer)),
    signal ? { signal } : undefined,
  );

const prewarmEnvironmentVoice = (
  context: EnvironmentVoiceRequestContext,
  payload: VoicePrewarmInput,
  signal?: AbortSignal,
) =>
  Effect.runPromise(
    executeAuthenticatedEnvironmentHttpRequest({
      ...requestAuth(context),
      timeoutMs: VOICE_PREWARM_TIMEOUT_MS,
      url: (urls) => urls.prewarm(),
      request: ({ client, headers }) => client.prewarm({ headers, payload }),
    }).pipe(Effect.provide(remoteHttpClientLayer)),
    signal ? { signal } : undefined,
  );

export interface RemoteVoiceTranscriberOptions {
  readonly locale: string;
  readonly resolveContext: () => Promise<EnvironmentVoiceRequestContext | null>;
  readonly readAudioBytes: (uri: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly providerInstanceId?: ProviderInstanceId | null;
  readonly threadId?: ThreadId | null;
}

/** Sends a finished 24 kHz mono WAV to the environment that owns the thread. */
export function createRemoteVoiceTranscriber(
  options: RemoteVoiceTranscriberOptions,
): VoiceTranscriber {
  const routing = {
    ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {}),
  };
  const unavailable = () =>
    new VoiceTranscriptionError(
      "unavailable",
      "Connect to an environment before using voice transcription.",
    );
  return {
    prepare: async ({ signal }): Promise<PreparedVoiceTranscription> => {
      throwIfVoiceTranscriptionAborted(signal);
      const context = await options.resolveContext();
      if (!context) throw unavailable();
      // A signed-out Codex fails here, before the user records anything.
      try {
        await prewarmEnvironmentVoice(context, routing, signal);
      } catch (error) {
        throwIfVoiceTranscriptionAborted(signal);
        throw new VoiceTranscriptionError("preparation-failed", failureMessage(error), {
          cause: error,
        });
      }
      return {
        locale: options.locale,
        transcribe: async (uri, { signal: transcribeSignal }) => {
          throwIfVoiceTranscriptionAborted(transcribeSignal);
          try {
            const bytes = await options.readAudioBytes(uri, transcribeSignal);
            const validated = validateCanonicalVoiceWav(bytes);
            if (!validated.ok)
              throw new VoiceTranscriptionError("transcription-failed", validated.reason);
            const currentContext = (await options.resolveContext()) ?? context;
            const result = await transcribeEnvironmentVoice(
              currentContext,
              {
                audioBase64: uint8ArrayToBase64(validated.value.bytes),
                mimeType: "audio/wav",
                sampleRateHz: VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
                durationMs: validated.value.sampleDurationMs,
                locale: options.locale,
                ...routing,
              },
              transcribeSignal,
            );
            return result.text.trim();
          } catch (error) {
            throwIfVoiceTranscriptionAborted(transcribeSignal);
            if (error instanceof VoiceTranscriptionError) throw error;
            throw new VoiceTranscriptionError("transcription-failed", failureMessage(error), {
              cause: error,
            });
          }
        },
      };
    },
  };
}

function failureMessage(error: unknown): string {
  const message =
    typeof error === "object" && error !== null ? Reflect.get(error, "message") : null;
  return typeof message === "string" && message.length > 0
    ? message
    : "Voice transcription failed.";
}
