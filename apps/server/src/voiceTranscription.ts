import {
  AuthOrchestrationOperateScope,
  CodexSettings,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  ProviderInstanceId,
  VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
  VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES,
  VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES,
  VoicePrewarmInput,
  VoiceTranscriptionBadRequestError,
  VoiceTranscriptionInput,
  VoiceTranscriptionPayloadTooLargeError,
  VoiceTranscriptionUpstreamError,
  type VoiceTranscriptionErrorCode,
} from "@t3tools/contracts";
import { base64ToUint8Array, validateCanonicalVoiceWav } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
} from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "./auth/http.ts";
import {
  ProjectionStoreV2,
  layer as layerProjectionStoreV2,
} from "./orchestration-v2/ProjectionStore.ts";
import { makeCodexChatGptAuth } from "./provider/CodexChatGptAuth.ts";
import { withCodexAppServerClient } from "./provider/CodexProvider.ts";
import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";
import { resolveCodexLaunchArgs } from "./provider/codexLaunchArgs.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const CHATGPT_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeTranscription = Schema.decodeEffect(Schema.fromJsonString(VoiceTranscriptionInput));
const decodePrewarm = Schema.decodeEffect(Schema.fromJsonString(VoicePrewarmInput));
const isUpstreamError = Schema.is(VoiceTranscriptionUpstreamError);
const isForbiddenError = Schema.is(EnvironmentHttpForbiddenError);

const upstreamError = (code: VoiceTranscriptionErrorCode = "upstream-failed", retryable = true) =>
  new VoiceTranscriptionUpstreamError({
    code,
    retryable,
    message:
      code === "upstream-auth-expired"
        ? "The Codex account rejected its credentials. Sign in again."
        : code === "voice-backend-unavailable"
          ? "Voice transcription needs a Codex instance signed in with ChatGPT."
          : "Voice transcription could not be completed.",
  });
const invalidAudio = () =>
  new VoiceTranscriptionBadRequestError({
    code: "invalid-audio",
    message: "Expected a valid 24 kHz mono PCM16 WAV and matching duration.",
  });

/** Credentials stay attached to one Codex instance for the whole request. */
interface VoiceSession {
  readonly token: (
    refresh: boolean,
  ) => Effect.Effect<string, VoiceTranscriptionUpstreamError, Scope.Scope>;
}

export class VoiceSessions extends Context.Service<
  VoiceSessions,
  {
    readonly resolve: (
      input: VoicePrewarmInput,
    ) => Effect.Effect<
      VoiceSession,
      VoiceTranscriptionUpstreamError | EnvironmentHttpForbiddenError,
      Scope.Scope
    >;
  }
>()("t3/voiceTranscription/VoiceSessions") {}

const forbidden = () =>
  new EnvironmentHttpForbiddenError({ message: "The requested thread is not accessible." });

export const layerSessions = Layer.effect(
  VoiceSessions,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const projectionStore = yield* ProjectionStoreV2;
    const hostCwd = yield* HostProcess.WorkingDirectory;
    // Capture the environment in which the resolver is constructed, including platform services.
    const services =
      yield* Effect.context<
        Exclude<
          | Effect.Services<ReturnType<typeof makeCodexChatGptAuth>>
          | Effect.Services<ReturnType<typeof withCodexAppServerClient>>
          | Path.Path,
          Scope.Scope
        >
      >();
    return VoiceSessions.of({
      resolve: Effect.fn("VoiceSessions.resolve")(
        function* (input: VoicePrewarmInput) {
          const thread = input.threadId
            ? yield* projectionStore.getThread(input.threadId).pipe(
                Effect.filterOrFail(
                  (row) => row.deletedAt === null,
                  () => forbidden(),
                ),
                Effect.mapError(forbidden),
              )
            : undefined;
          const settings = yield* settingsService.getSettings;
          const isUsableCodex = (id: string | undefined) => {
            const entry = id ? settings.providerInstances[ProviderInstanceId.make(id)] : undefined;
            return entry?.driver === "codex" && entry.enabled !== false;
          };
          const requestedId = input.providerInstanceId ?? thread?.modelSelection.instanceId;
          const preferred = settings.defaultModelSelection?.instanceId;
          const instanceId = [requestedId, preferred, "codex"].find(isUsableCodex) as
            | ProviderInstanceId
            | undefined;
          const entry = instanceId ? settings.providerInstances[instanceId] : undefined;
          if (!entry || !instanceId)
            return yield* upstreamError("voice-backend-unavailable", false);
          const config = yield* decodeCodexSettings(entry.config ?? {});
          if (!config.enabled) return yield* upstreamError("voice-backend-unavailable", false);
          if (config.setupMode === "managed") {
            const auth = yield* makeCodexChatGptAuth({ instanceId });
            // `access` renews a token that is about to expire, so a retry needs no extra flag.
            return {
              token: () =>
                auth.access.pipe(
                  Effect.map((credentials) => credentials.accessToken),
                  Effect.mapError(() => upstreamError("upstream-auth-expired", false)),
                ),
            };
          }
          const environment = yield* mergeProviderInstanceEnvironment(entry.environment);
          const layout = yield* resolveCodexHomeLayout(config);
          // Spawn lazily so a failed first attempt costs no process.
          let connection: Effect.Success<ReturnType<typeof withCodexAppServerClient>> | undefined;
          const token = Effect.fn("voice.session.token")(
            function* (refresh: boolean) {
              connection ??= yield* withCodexAppServerClient({
                binaryPath: config.binaryPath,
                homePath:
                  layout.effectiveHomePath ?? environment.CODEX_HOME ?? layout.sharedHomePath,
                launchArgs: resolveCodexLaunchArgs(config.launchArgs, environment),
                cwd: thread?.worktreePath ?? hostCwd,
                environment,
              });
              const result = yield* connection.client.request("getAuthStatus", {
                includeToken: true,
                refreshToken: refresh,
              });
              if (result.authMethod !== "chatgpt" || !result.authToken)
                return yield* upstreamError("voice-backend-unavailable", false);
              return result.authToken;
            },
            Effect.mapError((error) =>
              isUpstreamError(error) ? error : upstreamError("upstream-auth-expired", false),
            ),
            Effect.provide(services),
          );
          return { token };
        },
        Effect.mapError((error) =>
          isUpstreamError(error) || isForbiddenError(error)
            ? error
            : upstreamError("voice-backend-unavailable", false),
        ),
        Effect.provide(services),
      ),
    });
  }),
);

function boundedText<E, R, E2>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
  tooLarge: () => E2,
) {
  return Effect.suspend(() => {
    let bytes = 0;
    return stream.pipe(
      Stream.tap((chunk) => {
        bytes += chunk.byteLength;
        return bytes > maxBytes ? Effect.fail(tooLarge()) : Effect.void;
      }),
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (text, chunk) => text + chunk,
      ),
    );
  });
}

const readBoundedJsonRequestBody = Effect.fn("voice.readBoundedJsonRequestBody")(function* (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
) {
  const tooLarge = () =>
    new VoiceTranscriptionPayloadTooLargeError({
      code: "invalid-audio",
      message: "Voice request exceeds its size limit.",
    });
  if (Number(request.headers["content-length"]) > maxBytes) return yield* tooLarge();
  return yield* boundedText(
    request.stream.pipe(Stream.mapError(() => invalidAudio())),
    maxBytes,
    tooLarge,
  );
});

const readBoundedUpstreamJson = Effect.fn("voice.readBoundedUpstreamJson")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (Number(response.headers["content-length"]) > VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES)
    return yield* upstreamError();
  const text = yield* boundedText(
    response.stream.pipe(Stream.mapError(() => upstreamError())),
    VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES,
    upstreamError,
  );
  return yield* decodeJson(text).pipe(Effect.mapError(() => upstreamError()));
});

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const transcribe = Effect.fn("voice.transcribe")(
  function* (session: VoiceSession, input: VoiceTranscriptionInput, bytes: Uint8Array) {
    const http = yield* HttpClient.HttpClient;
    const upload = Effect.fn("voice.upload")(function* (token: string) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "voice.wav");
      if (input.locale) form.append("language", input.locale.split(/[-_]/)[0] ?? input.locale);
      const response = yield* HttpClient.withScope(http)
        .execute(
          HttpClientRequest.post(CHATGPT_TRANSCRIBE_URL).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
            HttpClientRequest.bodyFormData(form),
          ),
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            credentials: "omit",
          }),
        );
      // Authentication is classified before parsing: proxies often return HTML on rejection.
      if (response.status === 401 || response.status === 403) return { rejected: true as const };
      const body = yield* readBoundedUpstreamJson(response);
      if (response.status < 200 || response.status >= 300)
        return yield* upstreamError(
          response.status === 429 ? "upstream-rate-limited" : "upstream-failed",
          response.status === 429 || response.status >= 500,
        );
      const text = record(body)?.text;
      if (typeof text !== "string") return yield* upstreamError();
      return { rejected: false as const, text };
    }, Effect.scoped);
    let token = yield* session.token(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* upload(token);
      if (!result.rejected) return { text: result.text };
      if (attempt === 0) token = yield* session.token(true);
    }
    return yield* upstreamError("upstream-auth-expired", false);
  },
  Effect.mapError((error) => (isUpstreamError(error) ? error : upstreamError())),
  Effect.timeout("120 seconds"),
  Effect.catchTags({ TimeoutError: () => Effect.fail(upstreamError("upstream-timeout")) }),
);

export const layerHttp = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* VoiceSessions;
    const http = yield* HttpClient.HttpClient;
    return handlers
      .handleRaw(
        "transcribe",
        Effect.fn("voice.http.transcribe")(function* ({ request }) {
          yield* annotateEnvironmentRequest("transcribe");
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const text = yield* readBoundedJsonRequestBody(
            request,
            VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES,
          );
          const input = yield* decodeTranscription(text).pipe(Effect.mapError(invalidAudio));
          const bytes = base64ToUint8Array(input.audioBase64);
          if (!bytes || !validateCanonicalVoiceWav(bytes, input.durationMs).ok)
            return yield* invalidAudio();
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* sessions.resolve(input);
              return yield* transcribe(session, input, bytes).pipe(
                Effect.provideService(HttpClient.HttpClient, http),
              );
            }),
          );
        }),
      )
      .handleRaw(
        "prewarm",
        Effect.fn("voice.http.prewarm")(function* ({ request }) {
          yield* annotateEnvironmentRequest("prewarm");
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const text = yield* readBoundedJsonRequestBody(
            request,
            VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
          );
          const input = yield* decodePrewarm(text).pipe(Effect.mapError(invalidAudio));
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* sessions.resolve(input);
              yield* session.token(false);
              return { ready: true };
            }),
          ).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              TimeoutError: () => Effect.fail(upstreamError("upstream-timeout")),
            }),
          );
        }),
      );
  }),
);

export const layer = layerHttp.pipe(
  Layer.provide(layerSessions.pipe(Layer.provide(layerProjectionStoreV2))),
);
