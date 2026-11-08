import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  encodeMonoPcm16Wav,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import {
  createRemoteVoiceTranscriber,
  resolveEnvironmentVoiceContext,
  type EnvironmentVoiceRequestContext,
} from "./remoteTranscription.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

const environmentId = EnvironmentId.make("environment-voice");
const prepared: PreparedConnection = {
  environmentId,
  label: "Workstation",
  httpBaseUrl: "https://env.test",
  socketUrl: "wss://env.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
  target: new RelayConnectionTarget({ environmentId, label: "Workstation" }),
};
const context: EnvironmentVoiceRequestContext = { prepared };

const wavBytes = () => encodeMonoPcm16Wav([new Float32Array(24_000).fill(0.5)], 24_000)!.bytes;

type Reply = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(reply: Reply) {
  const calls: { url: string; body: unknown; headers: Headers }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const rawBody = request ? await request.text() : init?.body;
    const text =
      typeof rawBody === "string"
        ? rawBody
        : rawBody instanceof Uint8Array
          ? new TextDecoder().decode(rawBody)
          : "";
    calls.push({
      url,
      body: text ? JSON.parse(text) : undefined,
      headers: new Headers(request?.headers ?? init?.headers),
    });
    return reply(url, init);
  });
  return calls;
}

const okReply: Reply = (url) =>
  Response.json(url.endsWith("/prewarm") ? { ready: true } : { text: "  hello there  " });

function transcriber(overrides: Partial<Parameters<typeof createRemoteVoiceTranscriber>[0]> = {}) {
  return createRemoteVoiceTranscriber({
    locale: "pt-BR",
    resolveContext: async () => context,
    readAudioBytes: async () => wavBytes(),
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId: ThreadId.make("thread-1"),
    ...overrides,
  });
}

const prepare = (t: ReturnType<typeof transcriber>, signal = new AbortController().signal) =>
  t.prepare({ signal });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRemoteVoiceTranscriber", () => {
  it("prewarms the thread's environment, then sends the WAV with the thread routing", async () => {
    const calls = stubFetch(okReply);
    const prepared = await prepare(transcriber());
    expect(calls.map((call) => call.url)).toEqual(["https://env.test/api/voice/prewarm"]);
    expect(calls[0]!.body).toEqual({ providerInstanceId: "codex", threadId: "thread-1" });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer bearer-token");

    const text = await prepared.transcribe("blob:wav", { signal: new AbortController().signal });
    expect(text).toBe("hello there");
    expect(calls[1]!.url).toBe("https://env.test/api/voice/transcribe");
    expect(calls[1]!.body).toMatchObject({
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1_000,
      locale: "pt-BR",
      providerInstanceId: "codex",
      threadId: "thread-1",
    });
    expect(prepared.locale).toBe("pt-BR");
  });

  it("omits routing it was not given", async () => {
    const calls = stubFetch(okReply);
    await prepare(transcriber({ providerInstanceId: null, threadId: null }));
    expect(calls[0]!.body).toEqual({});
  });

  it("fails fast when no environment connection exists", async () => {
    stubFetch(okReply);
    await expect(prepare(transcriber({ resolveContext: async () => null }))).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("reports a failed prewarm as a preparation error before anything is recorded", async () => {
    stubFetch(() =>
      Response.json(
        {
          _tag: "VoiceTranscriptionUpstreamError",
          message: "No Codex",
          code: "voice-backend-unavailable",
          retryable: false,
        },
        { status: 502 },
      ),
    );
    const error = await prepare(transcriber()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "preparation-failed", message: "No Codex" });
  });

  it("does not report an abort during prewarm as a failure", async () => {
    stubFetch(okReply);
    const controller = new AbortController();
    controller.abort();
    await expect(prepare(transcriber(), controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("rejects audio that is not the canonical WAV before uploading it", async () => {
    const calls = stubFetch(okReply);
    const ready = await prepare(transcriber({ readAudioBytes: async () => new Uint8Array(10) }));
    await expect(
      ready.transcribe("blob:bad", { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "transcription-failed" });
    expect(calls).toHaveLength(1);
  });

  it("maps a failed upload to a transcription error and a cancelled one to cancelled", async () => {
    stubFetch((url) =>
      url.endsWith("/prewarm")
        ? Response.json({ ready: true })
        : Response.json(
            {
              _tag: "VoiceTranscriptionUpstreamError",
              message: "Voice transcription could not be completed.",
              code: "upstream-failed",
              retryable: true,
            },
            { status: 502 },
          ),
    );
    const ready = await prepare(transcriber());
    await expect(
      ready.transcribe("blob:wav", { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "transcription-failed",
      message: "Voice transcription could not be completed.",
    });

    const aborted = new AbortController();
    aborted.abort();
    await expect(ready.transcribe("blob:wav", { signal: aborted.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("does not show transport details for an undeclared server failure", async () => {
    stubFetch((url) =>
      url.endsWith("/prewarm") ? Response.json({ ready: true }) : new Response("", { status: 500 }),
    );
    const ready = await prepare(transcriber());
    await expect(
      ready.transcribe("blob:wav", { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "transcription-failed",
      message: "Voice transcription failed.",
    });
  });

  it("keeps the prewarm connection when the environment connection drops during recording", async () => {
    const calls = stubFetch(okReply);
    let available = true;
    const ready = await prepare(
      transcriber({ resolveContext: async () => (available ? context : null) }),
    );
    available = false;
    expect(await ready.transcribe("blob:wav", { signal: new AbortController().signal })).toBe(
      "hello there",
    );
    expect(calls).toHaveLength(2);
  });
});

describe("resolveEnvironmentVoiceContext", () => {
  effectIt.effect("reads the optional signer and remote authorization from the runtime", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveEnvironmentVoiceContext(prepared);
      expect(resolved.prepared).toBe(prepared);
      expect(Option.isNone(resolved.signer)).toBe(true);
      expect(Option.isNone(resolved.remoteAuthorization)).toBe(true);
    }),
  );
});
