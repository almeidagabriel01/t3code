import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
  VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES,
  VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES,
  encodeMonoPcm16Wav,
  uint8ArrayToBase64,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Etag, FetchHttpClient, HttpPlatform, HttpRouter } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import {
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
} from "./orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import * as VoiceTranscription from "./voiceTranscription.ts";

const appServer = vi.hoisted(() => ({
  spawns: [] as unknown[],
  requests: [] as unknown[],
  spawnFails: false,
  authStatus: { authMethod: "chatgpt", authToken: "app-token" } as Record<string, unknown>,
}));

vi.mock("./provider/CodexProvider.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    withCodexAppServerClient: (input: unknown) =>
      appServer.spawnFails
        ? Effect.fail({ _tag: "SpawnFailed" as const })
        : Effect.sync(() => {
            appServer.spawns.push(input);
            return {
              client: {
                request: (_method: string, params: unknown) =>
                  Effect.sync(() => {
                    appServer.requests.push(params);
                    return appServer.authStatus;
                  }),
              },
            };
          }),
  };
});

class VoiceTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.voice) {}

function audioInput(mutate?: (view: DataView) => void) {
  const wav = encodeMonoPcm16Wav([new Float32Array(24_000)], 24_000)!;
  mutate?.(new DataView(wav.bytes.buffer));
  return {
    audioBase64: uint8ArrayToBase64(wav.bytes),
    mimeType: "audio/wav",
    sampleRateHz: 24_000,
    durationMs: 1_000,
  };
}

const serve = Effect.fn("test.voice.serve")(function* (
  options: { operate?: boolean; fetch?: typeof fetch } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const tokens: boolean[] = [];
  const resolved = vi.fn();
  const layerAuth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        scopes: new Set(options.operate === false ? [] : [AuthOrchestrationOperateScope]),
      } as unknown as EnvironmentAuthenticatedPrincipal["Service"]),
    ),
  );
  const http = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return options.fetch ? options.fetch(url, init) : Response.json({ text: "voice draft" });
      }) as typeof fetch),
    ),
  );
  const sessions = Layer.succeed(VoiceTranscription.VoiceSessions, {
    resolve: () =>
      Effect.sync(() => {
        resolved();
        return {
          token: (refresh: boolean) =>
            Effect.sync(() => {
              tokens.push(refresh);
              return refresh ? "renewed-session-token" : "session-token";
            }),
        };
      }),
  });
  const app = HttpApiBuilder.layer(VoiceTestApi).pipe(
    Layer.provide(VoiceTranscription.layerHttp),
    Layer.provide(layerAuth),
    Layer.provide(sessions),
    Layer.provide(http),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Etag.layerWeak),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
  const post = (
    body: string | ReadableStream<Uint8Array>,
    path: string,
    headers: Record<string, string>,
  ) =>
    Effect.promise(() =>
      handler(
        new Request(`http://localhost/api/voice/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
          duplex: "half",
        } as RequestInit),
        Context.empty(),
      ),
    );
  return {
    calls,
    tokens,
    resolved,
    send: (body: unknown = audioInput(), path = "transcribe") =>
      post(typeof body === "string" ? body : JSON.stringify(body), path, {}),
    stream: (body: ReadableStream<Uint8Array>, path: string, headers = {}) =>
      post(body, path, headers),
  };
});

const pendingBody = (onPull: () => void) =>
  new ReadableStream<Uint8Array>({ pull: onPull }, { highWaterMark: 0 });

it.layer(NodeServices.layer)("mounted voice API", (it) => {
  it.effect.each(["transcribe", "prewarm"])("requires operate scope before reading %s", (path) =>
    Effect.gen(function* () {
      const h = yield* serve({ operate: false });
      let pulled = 0;
      const result = yield* h.stream(
        pendingBody(() => pulled++),
        path,
      );
      expect(result.status).toBe(403);
      expect(pulled).toBe(0);
      expect(h.resolved).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    }),
  );

  it.effect("sends the WAV and locale to ChatGPT with the session token", () =>
    Effect.gen(function* () {
      const h = yield* serve();
      const response = yield* h.send({ ...audioInput(), locale: "pt-BR" });
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ text: "voice draft" });
      expect(h.calls[0]!.url).toBe("https://chatgpt.com/backend-api/transcribe");
      expect(new Headers(h.calls[0]!.init.headers).get("authorization")).toBe(
        "Bearer session-token",
      );
      const form = h.calls[0]!.init.body as FormData;
      expect(form.get("language")).toBe("pt");
      expect((form.get("file") as File).type).toBe("audio/wav");
    }),
  );

  it.effect.each([
    ["magic", (v: DataView) => v.setUint32(0, 0)],
    ["stereo", (v: DataView) => v.setUint16(22, 2, true)],
    ["rate", (v: DataView) => v.setUint32(24, 16_000, true)],
    ["format", (v: DataView) => v.setUint16(20, 3, true)],
    ["bits", (v: DataView) => v.setUint16(34, 8, true)],
    ["align", (v: DataView) => v.setUint16(32, 4, true)],
    ["byte rate", (v: DataView) => v.setUint32(28, 32_000, true)],
    ["odd data", (v: DataView) => v.setUint32(40, 47_999, true)],
    ["empty data", (v: DataView) => v.setUint32(40, 0, true)],
    ["short riff boundary", (v: DataView) => v.setUint32(4, 36, true)],
  ] as const)("rejects invalid WAV %s before resolving credentials", ([_, mutate]) =>
    Effect.gen(function* () {
      const h = yield* serve();
      const response = yield* h.send(audioInput(mutate));
      expect(response.status).toBe(400);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ code: "invalid-audio" });
      expect(h.resolved).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    }),
  );

  it.effect.each(["duration", "base64", "json"])("rejects invalid %s without uploading", (kind) =>
    Effect.gen(function* () {
      const h = yield* serve();
      const body =
        kind === "json"
          ? "{"
          : {
              ...audioInput(),
              ...(kind === "duration" ? { durationMs: 1_251 } : { audioBase64: "!!!!" }),
            };
      expect((yield* h.send(body)).status).toBe(400);
      expect(h.calls).toHaveLength(0);
    }),
  );

  it.effect.each([401, 403])("renews a rejected ChatGPT %i once", (status) =>
    Effect.gen(function* () {
      let count = 0;
      const h = yield* serve({
        fetch: async () =>
          ++count === 1 ? new Response("", { status }) : Response.json({ text: "renewed draft" }),
      });
      expect((yield* h.send()).status).toBe(200);
      expect(h.tokens).toEqual([false, true]);
      expect(h.calls.map((call) => new Headers(call.init.headers).get("authorization"))).toEqual([
        "Bearer session-token",
        "Bearer renewed-session-token",
      ]);
    }),
  );

  it.effect("stops after a second rejection with a non-retryable auth error", () =>
    Effect.gen(function* () {
      const h = yield* serve({ fetch: async () => new Response("", { status: 401 }) });
      const response = yield* h.send();
      expect(response.status).toBe(502);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "upstream-auth-expired",
        retryable: false,
      });
      expect(h.calls).toHaveLength(2);
    }),
  );

  it.effect.each([
    [429, "upstream-rate-limited", true],
    [500, "upstream-failed", true],
    [400, "upstream-failed", false],
  ] as const)("maps upstream %i to %s (retryable=%s)", ([status, code, retryable]) =>
    Effect.gen(function* () {
      const h = yield* serve({ fetch: async () => Response.json({}, { status }) });
      const response = yield* h.send();
      expect(response.status).toBe(502);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ code, retryable });
    }),
  );

  it.effect("fails when the upstream reply carries no text", () =>
    Effect.gen(function* () {
      const h = yield* serve({ fetch: async () => Response.json({ other: 1 }) });
      expect((yield* h.send()).status).toBe(502);
    }),
  );

  it.effect.each([
    ["transcribe", VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES],
    ["prewarm", VOICE_PREWARM_MAX_REQUEST_BODY_BYTES],
  ] as const)("rejects declared oversized %s before pulling any body", ([path, cap]) =>
    Effect.gen(function* () {
      const h = yield* serve();
      let pulled = 0;
      const response = yield* h.stream(
        pendingBody(() => pulled++),
        path,
        { "content-length": String(cap + 1) },
      );
      expect(response.status).toBe(413);
      expect(pulled).toBe(0);
      expect(h.resolved).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    ["transcribe", VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES],
    ["prewarm", VOICE_PREWARM_MAX_REQUEST_BODY_BYTES],
  ] as const)("bounds a chunked %s body whose length header lies", ([path, cap]) =>
    Effect.gen(function* () {
      const h = yield* serve();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => controller.enqueue(new Uint8Array(cap / 2 + 1).fill(123)),
          cancel: () => {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const response = yield* h.stream(body, path, { "content-length": "1" });
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(h.resolved).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([true, false])(
    "bounds upstream responses and releases the stream (length=%s)",
    (declared) =>
      Effect.gen(function* () {
        let cancelled = false;
        let pulls = 0;
        const h = yield* serve({
          fetch: async () =>
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    pulls++;
                    controller.enqueue(
                      new Uint8Array(VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES / 2 + 1),
                    );
                  },
                  cancel() {
                    cancelled = true;
                  },
                },
                { highWaterMark: 0 },
              ),
              {
                headers: declared
                  ? { "content-length": String(VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES + 1) }
                  : {},
              },
            ),
        });
        const response = yield* h.send();
        expect(response.status).toBe(502);
        expect(declared ? pulls === 0 : cancelled).toBe(true);
      }),
  );

  it.effect("prewarms only credentials and never uploads audio", () =>
    Effect.gen(function* () {
      const h = yield* serve();
      const response = yield* h.send({}, "prewarm");
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ ready: true });
      expect(h.tokens).toEqual([false]);
      expect(h.calls).toHaveLength(0);
    }),
  );
});

it.layer(NodeServices.layer)("voice session resolution", (it) => {
  const claudeId = ProviderInstanceId.make("claude");
  const codexId = ProviderInstanceId.make("codex");
  const threadId = ThreadId.make("thread-valid");
  const deletedId = ThreadId.make("thread-deleted");
  const modelSelection = { provider: "claude", instanceId: claudeId, model: "claude-4" };

  const sessionsWith = (providerInstances: Record<string, unknown>) => {
    const secrets = new Map<string, Uint8Array>();
    return VoiceTranscription.layerSessions.pipe(
      Layer.provide(
        Layer.succeed(ServerSettingsService, {
          getSettings: Effect.succeed({
            defaultModelSelection: modelSelection,
            providerInstances,
          } as never),
        } as unknown as ServerSettingsService["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProjectionStoreV2, {
          getThread: (id: ThreadId) =>
            id === threadId
              ? Effect.succeed({
                  id: threadId,
                  projectId: ProjectId.make("project-1"),
                  worktreePath: null,
                  deletedAt: null,
                  modelSelection,
                } as never)
              : id === deletedId
                ? Effect.succeed({ id, deletedAt: "2026-10-27T00:00:00Z", modelSelection } as never)
                : Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: id })),
        } as unknown as ProjectionStoreV2["Service"]),
      ),
      Layer.provide(
        Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: (key) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(key))),
            set: (key, value) =>
              Effect.sync(() => {
                secrets.set(key, value);
              }),
            remove: (key) =>
              Effect.sync(() => {
                secrets.delete(key);
              }),
            create: () => Effect.die("unused"),
            getOrCreateRandom: () => Effect.die("unused"),
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("voice-environment")),
        }),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeCrypto.layer),
    );
  };
  const managedCodex = { driver: "codex", enabled: true, config: { setupMode: "managed" } };
  const resolve = (
    providerInstances: Record<string, unknown>,
    input: Parameters<VoiceTranscription.VoiceSessions["Service"]["resolve"]>[0],
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* VoiceTranscription.VoiceSessions;
        return yield* sessions.resolve(input);
      }).pipe(Effect.provide(sessionsWith(providerInstances))),
    );

  it.effect.each([
    ["unknown", ThreadId.make("thread-missing")],
    ["deleted", deletedId],
  ] as const)("refuses a %s thread", ([_, id]) =>
    Effect.gen(function* () {
      const error = yield* resolve({ [codexId]: managedCodex }, { threadId: id }).pipe(Effect.flip);
      expect(error._tag).toBe("EnvironmentHttpForbiddenError");
    }),
  );

  it.effect("falls back to the Codex instance when the thread's provider is not Codex", () =>
    Effect.gen(function* () {
      const session = yield* resolve(
        { [claudeId]: { driver: "claude", enabled: true, config: {} }, [codexId]: managedCodex },
        { threadId },
      );
      // Managed sessions fail on token only when nobody is signed in with ChatGPT.
      const error = yield* Effect.scoped(session.token(false)).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "upstream-auth-expired", retryable: false });
    }),
  );

  it.effect.each([
    ["no Codex instance", { [claudeId]: { driver: "claude", enabled: true, config: {} } }],
    ["a disabled Codex instance", { [codexId]: { ...managedCodex, enabled: false } }],
  ] as const)("reports the backend unavailable with %s", ([_, instances]) =>
    Effect.gen(function* () {
      const error = yield* resolve(instances, {}).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "voice-backend-unavailable", retryable: false });
    }),
  );
  const existingCodex = {
    driver: "codex",
    enabled: true,
    config: { setupMode: "existing", binaryPath: "codex" },
  };
  const resetAppServer = () => {
    appServer.spawns.length = 0;
    appServer.requests.length = 0;
    appServer.spawnFails = false;
    appServer.authStatus = { authMethod: "chatgpt", authToken: "app-token" };
  };

  it.effect("reads the token from one Codex app-server and asks it to refresh on retry", () =>
    Effect.gen(function* () {
      resetAppServer();
      const session = yield* resolve({ [codexId]: existingCodex }, { threadId });
      expect(appServer.spawns).toHaveLength(0);
      expect(yield* Effect.scoped(session.token(false))).toBe("app-token");
      expect(yield* Effect.scoped(session.token(true))).toBe("app-token");
      expect(appServer.spawns).toHaveLength(1);
      expect(appServer.requests).toEqual([
        { includeToken: true, refreshToken: false },
        { includeToken: true, refreshToken: true },
      ]);
    }),
  );

  it.effect.each([
    ["an API-key login", { authMethod: "apikey", authToken: null }],
    ["a missing token", { authMethod: "chatgpt", authToken: null }],
  ] as const)("reports the backend unavailable for %s", ([_, status]) =>
    Effect.gen(function* () {
      resetAppServer();
      appServer.authStatus = status;
      const session = yield* resolve({ [codexId]: existingCodex }, {});
      const error = yield* Effect.scoped(session.token(false)).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "voice-backend-unavailable", retryable: false });
    }),
  );

  it.effect("reports expired credentials when the app-server cannot start", () =>
    Effect.gen(function* () {
      resetAppServer();
      appServer.spawnFails = true;
      const session = yield* resolve({ [codexId]: existingCodex }, {});
      const error = yield* Effect.scoped(session.token(false)).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "upstream-auth-expired", retryable: false });
    }),
  );
});
