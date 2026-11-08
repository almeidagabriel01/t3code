import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const VOICE_TRANSCRIBE_PATH = "/api/voice/transcribe" as const;
export const VOICE_PREWARM_PATH = "/api/voice/prewarm" as const;
export const VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ = 24_000 as const;
export const VOICE_TRANSCRIPTION_MAX_DURATION_MS = 300_000 as const;
export const VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const VOICE_TRANSCRIPTION_MAX_BASE64_CHARS = 20_971_520;
export const VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES = 22 * 1024 * 1024;
export const VOICE_PREWARM_MAX_REQUEST_BODY_BYTES = 16 * 1024;
export const VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES = 1024 * 1024;

export const VoiceTranscriptionErrorCode = Schema.Literals([
  "invalid-audio",
  "voice-backend-unavailable",
  "upstream-auth-expired",
  "upstream-rate-limited",
  "upstream-timeout",
  "upstream-failed",
  "cancelled",
]);
export type VoiceTranscriptionErrorCode = typeof VoiceTranscriptionErrorCode.Type;

export class VoiceTranscriptionBadRequestError extends Schema.TaggedError<VoiceTranscriptionBadRequestError>()(
  "VoiceTranscriptionBadRequestError",
  {
    message: Schema.String,
    code: Schema.optionalKey(VoiceTranscriptionErrorCode),
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(VoiceTranscriptionBadRequestError)(this, { status: 400 });
  }
}

export class VoiceTranscriptionPayloadTooLargeError extends Schema.TaggedError<VoiceTranscriptionPayloadTooLargeError>()(
  "VoiceTranscriptionPayloadTooLargeError",
  {
    message: Schema.String,
    code: Schema.optionalKey(VoiceTranscriptionErrorCode),
  },
  { httpApiStatus: 413 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(VoiceTranscriptionPayloadTooLargeError)(this, {
      status: 413,
    });
  }
}

export class VoiceTranscriptionUpstreamError extends Schema.TaggedError<VoiceTranscriptionUpstreamError>()(
  "VoiceTranscriptionUpstreamError",
  {
    message: Schema.String,
    code: VoiceTranscriptionErrorCode,
    retryable: Schema.Boolean,
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(VoiceTranscriptionUpstreamError)(this, { status: 502 });
  }
}

export const VoiceTranscriptionInput = Schema.Struct({
  audioBase64: TrimmedNonEmptyString.check(
    Schema.isMaxLength(VOICE_TRANSCRIPTION_MAX_BASE64_CHARS),
  ),
  mimeType: Schema.Literal("audio/wav"),
  sampleRateHz: Schema.Literal(VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ),
  durationMs: Schema.Number.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(VOICE_TRANSCRIPTION_MAX_DURATION_MS),
  ),
  locale: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  threadId: Schema.optionalKey(ThreadId),
});
export type VoiceTranscriptionInput = typeof VoiceTranscriptionInput.Type;

export const VoiceTranscriptionResult = Schema.Struct({
  text: Schema.String,
});
export type VoiceTranscriptionResult = typeof VoiceTranscriptionResult.Type;

export const VoicePrewarmInput = Schema.Struct({
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  threadId: Schema.optionalKey(ThreadId),
});
export type VoicePrewarmInput = typeof VoicePrewarmInput.Type;

export const VoicePrewarmResult = Schema.Struct({
  ready: Schema.Boolean,
});
export type VoicePrewarmResult = typeof VoicePrewarmResult.Type;

export const VoiceHttpErrors = [
  VoiceTranscriptionBadRequestError,
  VoiceTranscriptionPayloadTooLargeError,
  VoiceTranscriptionUpstreamError,
] as const;

export * from "./voiceWav.ts";
