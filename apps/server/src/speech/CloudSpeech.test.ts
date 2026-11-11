import { it } from "@effect/vitest";
import {
  type ChatGptSpeechStatus,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  SecretProviderId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as ChatGptSpeechAuth from "./ChatGptSpeechAuth.ts";
import * as CloudSpeech from "./CloudSpeech.ts";

const signedOut = Layer.mock(ChatGptSpeechAuth.ChatGptSpeechAuth)({
  status: Effect.succeed("signed-out"),
  open: Effect.fail("signed-out" as const),
});

it.effect.each(["openai", "xai"] as const)("sends only to %s using its own saved key", (provider) =>
  Effect.gen(function* () {
    const reference = {
      provider: SecretProviderId.make("work"),
      reference: "op://Work/Voice/key",
    };
    let resolved: string | undefined;
    let cached: string | undefined;
    const read = vi.fn(() => Effect.sync(() => [(cached ??= resolved)]));
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ text: "hello" }));
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(signedOut),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(
            Layer.mock(SecretResolver.SecretResolver)({
              read,
              label: () => Effect.succeed("Work"),
              invalidate: () =>
                Effect.sync(() => {
                  cached = undefined;
                }),
            }),
          ),
        ),
      ),
    );
    const transcribe = (pcm = new Uint8Array(new Float32Array([0, 0.5]).buffer)) =>
      service
        .transcribe(provider, pcm, {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "en",
          speechCustomWords: [{ term: "T3 Code", aliases: [] }],
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey(provider === "openai" ? "xai" : "openai", Redacted.make("other"));
    expect((yield* Effect.flip(transcribe()))._tag).toBe("CloudSpeechError");
    yield* service.setKey(provider, Redacted.make("chosen"));
    expect(yield* service.configured).toEqual({
      openai: true,
      xai: true,
      openrouter: false,
      chatgpt: false,
      chatgptStatus: "signed-out",
    });
    yield* Effect.flip(transcribe(new Uint8Array(3)));
    expect(upstream).not.toHaveBeenCalled();
    expect(yield* transcribe()).toBe("hello");
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe(
      {
        openai: "https://api.openai.com/v1/audio/transcriptions",
        xai: "https://api.x.ai/v1/stt",
      }[provider],
    );
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer chosen");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe(
      provider === "openai" ? "gpt-transcribe" : "grok-voice-transcribe-2.0",
    );
    expect(form.getAll(provider === "openai" ? "keywords[]" : "keyterm")).toEqual(["T3 Code"]);
    expect(form.get(provider === "openai" ? "languages[]" : "language")).toBe("en");
    expect([...form.keys()].at(-1)).toBe("file");
    const wav = new DataView(yield* Effect.promise(() => (form.get("file") as Blob).arrayBuffer()));
    expect(wav.getUint32(24, true)).toBe(16_000);
    expect(wav.getInt16(46, true)).toBe(16384);
    upstream.mockResolvedValueOnce(new Response("sensitive upstream diagnostic", { status: 401 }));
    expect(yield* Effect.flip(transcribe())).toMatchObject({ provider, reason: "rejected-key" });
    yield* service.setKey(provider, null);
    expect((yield* service.configured)[provider]).toBe(false);
    yield* Effect.flip(transcribe());
    expect(upstream).toHaveBeenCalledTimes(2);
    yield* service.setKey(provider, reference);
    expect((yield* service.configured)[provider]).toBe(true);
    expect(read).not.toHaveBeenCalled();
    resolved = "resolved-fixture";
    expect(yield* transcribe()).toBe("hello");
    expect(read).toHaveBeenCalledWith([reference]);
    expect(new Headers(upstream.mock.calls[2]?.[1]?.headers).get("authorization")).toBe(
      "Bearer resolved-fixture",
    );
    resolved = undefined;
    expect(yield* Effect.flip(transcribe())).toMatchObject({
      provider,
      reason: "unreadable-key",
    });
    expect(upstream).toHaveBeenCalledTimes(3);
  }),
);

it.effect("uploads to OpenRouter only for a listed exact model, as zero-retention JSON WAV", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith("/models")
        ? Response.json({ data: [{ id: "acme/transcribe-1" }, { id: "acme/transcribe-2" }] })
        : Response.json({ text: "hello" }),
    );
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(signedOut),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const uploads = () =>
      upstream.mock.calls.filter(([url]) => String(url).endsWith("/audio/transcriptions"));
    const transcribe = (model: string | undefined) =>
      service
        .transcribe(
          "openrouter",
          new Uint8Array(new Float32Array([0, 0.5]).buffer),
          { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, speechLanguage: "en" },
          model,
        )
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey("openrouter", Redacted.make("router-key"));
    expect(yield* Effect.flip(transcribe(undefined))).toMatchObject({ provider: "openrouter" });
    upstream.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(yield* Effect.flip(transcribe("acme/transcribe-2"))).toMatchObject({
      reason: "unavailable",
    });
    expect(yield* Effect.flip(transcribe("acme/delisted"))).toMatchObject({
      provider: "openrouter",
    });
    expect(uploads()).toEqual([]);
    expect(yield* transcribe("acme/transcribe-2")).toBe("hello");
    const [[url, init]] = uploads() as [[URL, RequestInit]];
    expect(new URL(String(upstream.mock.calls[0]![0])).searchParams.get("zdr")).toBe("true");
    expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer router-key");
    expect(headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(yield* Effect.promise(() => new Response(init.body).text())) as {
      model: string;
      models?: unknown;
      provider: { zdr: boolean };
      input_audio: { format: string; data: string };
    };
    expect(body).toMatchObject({
      model: "acme/transcribe-2",
      provider: { zdr: true },
      input_audio: { format: "wav" },
    });
    expect(body.models).toBeUndefined();
    const wav = Buffer.from(body.input_audio.data, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readInt16LE(46)).toBe(16384);
  }),
);

it.effect("removing a key while a catalog read is pending prevents the upload", () =>
  Effect.gen(function* () {
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(signedOut),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const catalogStarted = Promise.withResolvers<void>();
    const catalog = Promise.withResolvers<Response>();
    const uploads: string[] = [];
    const upstream: typeof fetch = async (input) => {
      if (new URL(String(input)).pathname.endsWith("/models")) {
        catalogStarted.resolve();
        return catalog.promise;
      }
      uploads.push(String(input));
      return Response.json({ text: "unexpected" });
    };
    yield* service.setKey("openrouter", Redacted.make("old-key"));
    const job = yield* service
      .transcribe(
        "openrouter",
        new Uint8Array(4),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        "acme/voice",
      )
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.forkChild);
    yield* Effect.promise(() => catalogStarted.promise);
    yield* service.setKey("openrouter", null);
    catalog.resolve(Response.json({ data: [{ id: "acme/voice" }] }));
    const exit = yield* Fiber.await(job);
    expect(uploads).toEqual([]);
    expect(exit._tag).toBe("Failure");
  }),
);

const chatgptService = Effect.fn("test.chatgpt.service")(function* (auth: {
  status?: ChatGptSpeechStatus;
  open: Effect.Effect<
    ChatGptSpeechAuth.ChatGptSpeechSession,
    ChatGptSpeechAuth.ChatGptSpeechAuthFailure,
    Scope.Scope
  >;
}) {
  return yield* CloudSpeech.CloudSpeech.pipe(
    Effect.provide(
      CloudSpeech.layer.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.mock(ChatGptSpeechAuth.ChatGptSpeechAuth)({
            status: Effect.succeed(auth.status ?? "ready"),
            open: auth.open,
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
      ),
    ),
  );
});
const session = (accountId?: string) =>
  Effect.succeed({
    credentials: () => Effect.succeed({ token: Redacted.make("token"), accountId }),
  });

it.effect("ChatGPT dictation sends a 24 kHz WAV with the Codex token and renews once", () =>
  Effect.gen(function* () {
    const refreshes: boolean[] = [];
    const service = yield* chatgptService({
      open: Effect.succeed({
        credentials: (refresh) =>
          Effect.sync(() => {
            refreshes.push(refresh);
            return {
              token: Redacted.make(refresh ? "renewed" : "first"),
              accountId: refresh ? "acct-renewed" : undefined,
            };
          }),
      }),
    });
    const upstream = vi.fn<typeof fetch>(async (_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer first"
        ? new Response("denied", { status: 401 })
        : Response.json({ text: " hello " }),
    );
    const transcribe = (model?: string) =>
      service
        .transcribe(
          "chatgpt",
          new Uint8Array(new Float32Array([0, 0.5, 0, 0.5]).buffer),
          { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, speechLanguage: "pt" },
          model,
        )
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(yield* service.configured).toMatchObject({ chatgpt: true, chatgptStatus: "ready" });
    expect(yield* Effect.flip(transcribe("acme/model"))).toMatchObject({
      reason: "model-unavailable",
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(yield* transcribe()).toBe("hello");
    expect(refreshes).toEqual([false, true]);
    expect(new Headers(upstream.mock.calls[0]![1]?.headers).has("chatgpt-account-id")).toBe(false);
    const [url, init] = upstream.mock.calls[1]!;
    expect(String(url)).toBe("https://chatgpt.com/backend-api/transcribe");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("chatgpt-account-id")).toBe("acct-renewed");
    expect(headers.get("traceparent")).toBeNull();
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(["file", "language"]);
    expect(form.get("language")).toBe("pt");
    const file = form.get("file") as File;
    expect([file.type, file.name]).toEqual(["audio/wav", "audio.wav"]);
    const wav = new DataView(yield* Effect.promise(() => file.arrayBuffer()));
    expect(wav.getUint32(24, true)).toBe(24_000);
    expect(wav.getUint32(28, true)).toBe(48_000);
    expect(wav.getUint32(40, true)).toBe(12);
    expect(wav.getInt16(46, true)).toBe(10922);
  }),
);

it.effect.each([
  { name: "not signed in", failure: "signed-out", reason: "missing-key" },
  { name: "renewal refused", failure: "rejected", reason: "rejected-key" },
] as const)("ChatGPT dictation reports $name as $reason before uploading", ({ failure, reason }) =>
  Effect.gen(function* () {
    const service = yield* chatgptService({ open: Effect.fail(failure) });
    const upstream = vi.fn<typeof fetch>();
    const error = yield* service
      .transcribe("chatgpt", new Uint8Array(4), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.flip);
    expect(error).toMatchObject({ provider: "chatgpt", reason });
    expect(upstream).not.toHaveBeenCalled();
  }),
);

it.effect.each([
  {
    name: "credentials refused twice",
    reply: () => new Response("", { status: 401 }),
    reason: "rejected-key",
    calls: 2,
  },
  {
    name: "a plan refusal",
    reply: () => new Response("", { status: 403 }),
    reason: "rejected-key",
    calls: 1,
  },
  {
    name: "a usage limit",
    reply: () => new Response("", { status: 429 }),
    reason: "rate-limit",
    calls: 1,
  },
  {
    name: "a server error",
    reply: () => new Response("", { status: 503 }),
    reason: "unavailable",
    calls: 1,
  },
  {
    name: "a removed route",
    reply: () => new Response("", { status: 404 }),
    reason: "endpoint-changed",
    calls: 1,
  },
  {
    name: "a gone route",
    reply: () => new Response("", { status: 410 }),
    reason: "endpoint-changed",
    calls: 1,
  },
  {
    name: "a reply without text",
    reply: () => Response.json({ nope: 1 }),
    reason: "endpoint-changed",
    calls: 1,
  },
  {
    name: "an unreachable network",
    reply: () => Promise.reject(new TypeError("fetch failed")),
    reason: "network",
    calls: 1,
  },
])(
  "ChatGPT dictation maps $name to $reason and shows it until a success",
  ({ reply, reason, calls }) =>
    Effect.gen(function* () {
      const service = yield* chatgptService({ open: session("acct") });
      const upstream = vi.fn<typeof fetch>(async () => reply());
      const transcribe = service
        .transcribe("chatgpt", new Uint8Array(4), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      expect(yield* Effect.flip(transcribe)).toMatchObject({ provider: "chatgpt", reason });
      expect(upstream).toHaveBeenCalledTimes(calls);
      expect((yield* service.configured).chatgptLastFailure).toBe(reason);
      upstream.mockImplementation(async () => Response.json({ text: "ok" }));
      expect(yield* transcribe).toBe("ok");
      expect(yield* service.configured).not.toHaveProperty("chatgptLastFailure");
    }),
);

it.effect("ChatGPT dictation rejects invalid audio without recording a failure", () =>
  Effect.gen(function* () {
    const service = yield* chatgptService({ status: "keychain", open: session() });
    const error = yield* service
      .transcribe("chatgpt", new Uint8Array(3), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.flip);
    expect(error._tag).toBe("SpeechInvalidAudioError");
    expect(yield* service.configured).toEqual({
      openai: false,
      xai: false,
      openrouter: false,
      chatgpt: true,
      chatgptStatus: "keychain",
    });
  }),
);
