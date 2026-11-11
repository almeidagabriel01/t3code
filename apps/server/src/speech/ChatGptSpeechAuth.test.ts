import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as ChatGptSpeechAuth from "./ChatGptSpeechAuth.ts";

const codex = vi.hoisted(() => ({
  authStatus: { authMethod: "chatgpt", authToken: "app-token" } as Record<string, unknown>,
  spawnFails: false,
  spawns: [] as Array<{ homePath?: string }>,
  requests: [] as unknown[],
  closed: 0,
}));

vi.mock("../provider/CodexProvider.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    withCodexAppServerClient: (input: { homePath?: string }) =>
      codex.spawnFails
        ? Effect.fail(new Error("spawn codex ENOENT"))
        : Effect.acquireRelease(
            Effect.sync(() => {
              codex.spawns.push(input);
              return {
                client: {
                  request: (_method: string, params: unknown) =>
                    Effect.sync(() => {
                      codex.requests.push(params);
                      return codex.authStatus;
                    }),
                },
              };
            }),
            () => Effect.sync(() => void codex.closed++),
          ),
  };
});

const NOW = Date.UTC(2026, 10, 11);
const jwt = (claims: Record<string, unknown>) =>
  ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");
const fresh = jwt({
  exp: NOW / 1000 + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-claim" },
});
const old = jwt({ exp: NOW / 1000 - 60 });
const authFile = (tokens: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens, ...extra });

it.each([
  { name: "a missing file", raw: undefined, store: undefined, status: "signed-out" },
  { name: "a missing file with auto storage", raw: undefined, store: "auto", status: "keychain" },
  {
    name: "keyring storage",
    raw: authFile({ access_token: fresh }),
    store: "keyring",
    status: "keychain",
  },
  { name: "ephemeral storage", raw: undefined, store: "ephemeral", status: "signed-out" },
  {
    name: "API-key mode",
    raw: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test", tokens: null }),
    status: "api-key",
  },
  {
    name: "a legacy API key without a mode",
    raw: JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
    status: "api-key",
  },
  {
    name: "another sign-in method",
    raw: JSON.stringify({ auth_mode: "personalAccessToken", tokens: { access_token: fresh } }),
    status: "api-key",
  },
  {
    name: "a ChatGPT sign-in with unknown keys",
    raw: authFile(
      { access_token: fresh, refresh_token: "r", account_id: "acct-file", future: 1 },
      { last_refresh: "2026-11-10T00:00:00Z", agent_identity: null, later: { nested: true } },
    ),
    status: "ready",
  },
  {
    name: "host-supplied ChatGPT tokens",
    raw: authFile({ access_token: fresh }, { auth_mode: "chatgptAuthTokens" }),
    status: "ready",
  },
  {
    name: "an expired token Codex can refresh",
    raw: authFile({ access_token: old, refresh_token: "r" }),
    status: "ready",
  },
  {
    name: "an expired token without refresh",
    raw: authFile({ access_token: old }),
    status: "expired",
  },
  { name: "an empty object", raw: "{}", status: "signed-out" },
  { name: "malformed JSON", raw: '{"auth_mode": "chatgpt"', status: "unreadable" },
  {
    name: "tokens of the wrong type",
    raw: JSON.stringify({ tokens: "abc" }),
    status: "unreadable",
  },
  {
    name: "a token unsafe for a header",
    raw: authFile({ access_token: "a\nb" }),
    status: "unreadable",
  },
])("auth.json with $name is $status", ({ raw, store, status }) => {
  expect(
    ChatGptSpeechAuth.chatGptLoginStatus(ChatGptSpeechAuth.parseCodexLogin(raw, store), NOW),
  ).toBe(status);
});

it("prefers the file's account id and falls back to the token claim", () => {
  expect(
    ChatGptSpeechAuth.parseCodexLogin(
      authFile({ access_token: fresh, account_id: "acct-file" }),
      undefined,
    ),
  ).toMatchObject({ kind: "chatgpt", accountId: "acct-file", refreshable: false });
  expect(
    ChatGptSpeechAuth.parseCodexLogin(authFile({ access_token: fresh }), undefined),
  ).toMatchObject({
    accountId: "acct-claim",
    expiresAt: NOW + 3_600_000,
  });
  expect(ChatGptSpeechAuth.chatGptTokenClaims("opaque")).toEqual({
    expiresAt: undefined,
    accountId: undefined,
  });
});

it.each([
  { config: 'cli_auth_credentials_store = "keyring"\nmodel = "o3"', store: "keyring" },
  { config: "cli_auth_credentials_store='Auto'", store: "auto" },
  {
    config: 'model = "o3"\n[profiles.work]\ncli_auth_credentials_store = "keyring"',
    store: undefined,
  },
  { config: "", store: undefined },
])("reads the top-level credential store from config.toml as $store", ({ config, store }) => {
  expect(ChatGptSpeechAuth.codexCredentialStore(config)).toBe(store);
});

const instance = (config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  driver: "codex",
  config: { binaryPath: "codex", ...config },
  ...extra,
});

// The mocked Codex module never touches the services the real one requires.
// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
const layer = ChatGptSpeechAuth.layer as Layer.Layer<
  ChatGptSpeechAuth.ChatGptSpeechAuth,
  never,
  ServerSettings.ServerSettingsService | FileSystem.FileSystem | Path.Path
>;

const setup = Effect.fn(function* (files: Record<string, string> = {}) {
  codex.authStatus = { authMethod: "chatgpt", authToken: fresh };
  codex.spawnFails = false;
  codex.spawns.length = 0;
  codex.requests.length = 0;
  codex.closed = 0;
  yield* TestClock.setTime(NOW);
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  for (const [name, text] of Object.entries(files)) {
    yield* fs.makeDirectory(`${home}/${name.split("/").slice(0, -1).join("/")}`, {
      recursive: true,
    });
    yield* fs.writeFileString(`${home}/${name}`, text);
  }
  const authWith = (settings: Record<string, unknown>) =>
    ChatGptSpeechAuth.ChatGptSpeechAuth.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(ServerSettings.ServerSettingsService.layerTest(settings as never)),
        ),
      ),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
    );
  return { home, authWith };
});
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem | Path.Path>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));
const signedIn = (token: string, extra: Record<string, unknown> = {}) => ({
  ".codex/auth.json": authFile({ access_token: token, refresh_token: "r", ...extra }),
});

it.effect.each([
  {
    name: "Codex turned off",
    instances: { codex: instance({}, { enabled: false }) },
    status: "codex-off",
  },
  {
    name: "Codex disabled in its config",
    instances: { codex: instance({ enabled: false }) },
    status: "codex-off",
  },
  {
    name: "only a managed sign-in",
    instances: { codex: instance({ setupMode: "managed" }) },
    files: {},
    status: "managed",
  },
  {
    name: "a managed sign-in after codex login",
    instances: { codex: instance({ setupMode: "managed" }) },
    status: "ready",
  },
  { name: "the default home signed in", instances: {}, status: "ready" },
  {
    name: "an empty CODEX_HOME",
    instances: {
      codex: instance({}, { environment: [{ name: "CODEX_HOME", value: " ", sensitive: false }] }),
    },
    status: "ready",
  },
])("status is $status with $name and never starts Codex", ({ instances, files, status }) =>
  run(
    Effect.gen(function* () {
      const { authWith } = yield* setup(files ?? signedIn(fresh));
      const auth = yield* authWith({ providerInstances: instances });
      expect(yield* auth.status).toBe(status);
      expect(codex.spawns).toEqual([]);
    }),
  ),
);

it.effect("reads the home of the default model's Codex instance, then CODEX_HOME", () =>
  run(
    Effect.gen(function* () {
      const { home, authWith } = yield* setup({
        "work/auth.json": JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk" }),
        "env/config.toml": 'cli_auth_credentials_store = "keyring"',
        ...signedIn(fresh),
      });
      const work = yield* authWith({
        providerInstances: { codex: instance(), work: instance({ homePath: `${home}/work` }) },
        defaultModelSelection: { instanceId: "work", model: "gpt-5" },
      });
      expect(yield* work.status).toBe("api-key");
      const fromEnvironment = yield* authWith({
        providerInstances: {
          codex: instance(
            {},
            { environment: [{ name: "CODEX_HOME", value: `${home}/env`, sensitive: false }] },
          ),
        },
      });
      expect(yield* fromEnvironment.status).toBe("keychain");
    }),
  ),
);

it.effect("a current file token is used directly; a refusal asks Codex to renew it", () =>
  run(
    Effect.gen(function* () {
      const { home, authWith } = yield* setup(signedIn(fresh, { account_id: "acct-file" }));
      const auth = yield* authWith({ providerInstances: {} });
      const scope = yield* Scope.make();
      const session = yield* auth.open.pipe(Scope.provide(scope));
      const first = yield* session.credentials(false).pipe(Scope.provide(scope));
      expect([Redacted.value(first.token), first.accountId]).toEqual([fresh, "acct-file"]);
      expect(codex.spawns).toEqual([]);
      const renewed = yield* session.credentials(true).pipe(Scope.provide(scope));
      expect([Redacted.value(renewed.token), renewed.accountId]).toEqual([fresh, "acct-claim"]);
      expect(codex.spawns).toEqual([expect.objectContaining({ homePath: `${home}/.codex` })]);
      expect(codex.requests).toEqual([
        { includeToken: false, refreshToken: true },
        { includeToken: true, refreshToken: false },
      ]);
      yield* Scope.close(scope, Exit.void);
      expect(codex.closed).toBe(1);
    }),
  ),
);

it.effect("an expired file token is renewed by Codex before the first upload", () =>
  run(
    Effect.gen(function* () {
      const { authWith } = yield* setup(signedIn(old));
      const auth = yield* authWith({ providerInstances: {} });
      const session = yield* auth.open;
      expect(Redacted.value((yield* session.credentials(false)).token)).toBe(fresh);
      expect(codex.requests).toEqual([
        { includeToken: false, refreshToken: true },
        { includeToken: true, refreshToken: false },
      ]);
    }),
  ),
);

it.effect("a keychain sign-in asks Codex for the token without forcing a refresh", () =>
  run(
    Effect.gen(function* () {
      const { authWith } = yield* setup({
        ".codex/config.toml": "cli_auth_credentials_store = 'auto'",
      });
      const auth = yield* authWith({ providerInstances: {} });
      const session = yield* auth.open;
      expect((yield* session.credentials(false)).accountId).toBe("acct-claim");
      expect(codex.requests).toEqual([{ includeToken: true, refreshToken: false }]);
    }),
  ),
);

it.effect.each([
  {
    name: "Codex reports an API key",
    authStatus: { authMethod: "apikey", authToken: "sk" },
    failure: "signed-out",
  },
  {
    name: "Codex returns no token",
    authStatus: { authMethod: "chatgpt", authToken: null },
    failure: "rejected",
  },
  { name: "Codex cannot start", spawnFails: true, failure: "rejected" },
])("renewal fails as $failure when $name", ({ authStatus, spawnFails, failure }) =>
  run(
    Effect.gen(function* () {
      const { authWith } = yield* setup(signedIn(fresh));
      if (authStatus) codex.authStatus = authStatus;
      codex.spawnFails = spawnFails ?? false;
      const auth = yield* authWith({ providerInstances: {} });
      const session = yield* auth.open;
      expect(yield* Effect.flip(session.credentials(true))).toBe(failure);
    }),
  ),
);

it.effect.each([
  { name: "no sign-in", files: {}, instances: {} },
  {
    name: "an API-key sign-in",
    files: { ".codex/auth.json": '{"OPENAI_API_KEY":"sk"}' },
    instances: {},
  },
  {
    name: "only a managed sign-in",
    files: {},
    instances: { codex: instance({ setupMode: "managed" }) },
  },
])("opening with $name is signed out", ({ files, instances }) =>
  run(
    Effect.gen(function* () {
      const { authWith } = yield* setup(files);
      const auth = yield* authWith({ providerInstances: instances });
      expect(yield* Effect.flip(auth.open)).toBe("signed-out");
      expect(codex.spawns).toEqual([]);
    }),
  ),
);
