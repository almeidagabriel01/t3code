import { expect, it } from "@effect/vitest";
import { IntegrationCatalogEntry, type IntegrationBeginConnectInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import catalogJson from "./catalog.json" with { type: "json" };
import * as IntegrationAuth from "./IntegrationAuth.ts";
import * as IntegrationDetector from "./IntegrationDetector.ts";
import * as IntegrationFetch from "./IntegrationFetch.ts";

const MCP = "https://mcp.linear.app/mcp";
const AS = "https://auth.linear.test";

interface FakeOptions {
  /** `null` leaves `code_challenge_methods_supported` out of the metadata. */
  readonly pkceMethods?: ReadonlyArray<string> | null;
  readonly issuer?: string;
  readonly issSupported?: boolean;
  readonly challenge?: boolean;
  readonly registration?: boolean;
  readonly authorizationServer?: string;
  readonly authorizationEndpoint?: string;
  /** Serve resource metadata only at the root well-known, not the path-aware one. */
  readonly prmAtRoot?: boolean;
  /** A path on the authorization server's issuer, and which well-known serves its metadata. */
  readonly asPath?: string;
  readonly metadataAt?: "oauth" | "oidc-insert" | "oidc-append";
}

const sha256Base64Url = async (value: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "base64url",
  );

/** An in-process MCP resource server plus authorization server, reached through the real guard. */
const makeFake = (options: FakeOptions = {}) => {
  const requests: Array<string> = [];
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; resource: string | null; clientId: string }
  >();
  const revoked: Array<string> = [];
  let refreshToken = "rt-1";
  let issued = 1;
  let rejectRefresh = false;
  let codeCount = 0;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const asPath = options.asPath ?? "";
  const issuer = options.issuer ?? `${AS}${asPath}`;
  const metadataUrl = {
    oauth: `${AS}/.well-known/oauth-authorization-server${asPath}`,
    "oidc-insert": `${AS}/.well-known/openid-configuration${asPath}`,
    "oidc-append": `${AS}${asPath}/.well-known/openid-configuration`,
  }[options.metadataAt ?? "oauth"];
  const metadata = {
    issuer,
    authorization_endpoint: options.authorizationEndpoint ?? `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    revocation_endpoint: `${AS}/revoke`,
    response_types_supported: ["code"],
    // OpenID discovery documents must carry these.
    jwks_uri: `${AS}/jwks`,
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    ...(options.registration === false ? {} : { registration_endpoint: `${AS}/register` }),
    ...(options.pkceMethods === null
      ? {}
      : { code_challenge_methods_supported: options.pkceMethods ?? ["S256"] }),
    ...(options.issSupported === false
      ? {}
      : { authorization_response_iss_parameter_supported: true }),
  };
  const send: IntegrationFetch.IntegrationFetchFn = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.href}`);
    const body = new URLSearchParams(
      init?.body instanceof URLSearchParams || typeof init?.body === "string" ? init.body : "",
    );
    const prmPrefix = "/.well-known/oauth-protected-resource";
    if (url.origin !== AS) {
      if (method === "POST") {
        return options.challenge === false
          ? json(401, {})
          : json(
              401,
              {},
              {
                "www-authenticate": `Bearer resource_metadata="${url.origin}${prmPrefix}${url.pathname}", scope="read write"`,
              },
            );
      }
      const rest = url.pathname.startsWith(prmPrefix) ? url.pathname.slice(prmPrefix.length) : null;
      if (rest === null || (options.prmAtRoot ? rest !== "" : rest === "")) return json(404, {});
      return json(200, {
        resource: options.prmAtRoot ? MCP : `${url.origin}${rest}`,
        authorization_servers: [options.authorizationServer ?? `${AS}${asPath}`],
      });
    }
    if (url.href === metadataUrl) return json(200, metadata);
    if (url.href === `${AS}/register` && method === "POST") {
      const registered = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json(201, { ...registered, client_id: "dcr-client" });
    }
    if (url.href === `${AS}/revoke`) {
      revoked.push(body.get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (url.href === `${AS}/token`) {
      if (body.get("grant_type") === "authorization_code") {
        const grant = codes.get(body.get("code") ?? "");
        codes.delete(body.get("code") ?? "");
        const verifier = body.get("code_verifier") ?? "";
        if (
          grant === undefined ||
          grant.redirectUri !== body.get("redirect_uri") ||
          grant.resource !== body.get("resource") ||
          grant.challenge !== (await sha256Base64Url(verifier))
        ) {
          return json(400, { error: "invalid_grant" });
        }
        return json(200, {
          access_token: "at-1",
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read write",
        });
      }
      if (rejectRefresh || body.get("refresh_token") !== refreshToken) {
        return json(400, { error: "invalid_grant" });
      }
      issued += 1;
      refreshToken = `rt-${issued}`;
      return json(200, {
        access_token: `at-${issued}`,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return json(404, {});
  };
  /** The user signs in: the authorization server answers on the redirect URI. */
  const approve = (authorizationUrl: string, extra: Record<string, string> = {}) => {
    const url = new URL(authorizationUrl);
    codeCount += 1;
    const code = `code-${codeCount}`;
    codes.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      resource: url.searchParams.get("resource"),
      clientId: url.searchParams.get("client_id") ?? "",
    });
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({
      code,
      state: url.searchParams.get("state") ?? "",
      iss: issuer,
      ...extra,
    }).toString();
    return callback.href;
  };
  return {
    requests,
    revoked,
    send,
    approve,
    rejectRefresh: () => {
      rejectRefresh = true;
    },
  };
};

const makeMemorySecrets = () => {
  const values = new Map<string, Uint8Array>();
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
  const text = (name: string) => {
    const value = values.get(name);
    return value === undefined ? undefined : new TextDecoder().decode(value);
  };
  return { values, store, text };
};

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

const setup = (options: FakeOptions = {}) =>
  Effect.gen(function* () {
    const fake = makeFake(options);
    const secrets = makeMemorySecrets();
    const context = yield* Layer.build(
      IntegrationAuth.layer.pipe(
        Layer.provideMerge(ServerSettings.layerTest()),
        Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store)),
        Layer.provide(
          Layer.succeed(
            IntegrationDetector.IntegrationDetector,
            IntegrationDetector.IntegrationDetector.of({
              detect: Effect.succeed({ detected: [], sources: [] }),
              changes: Stream.empty,
              recordClaudeSession: () => Effect.void,
              nativeCatalogIds: () => Effect.succeed(new Set()),
              makeAvailable: () => Effect.die("unused"),
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            IntegrationFetch.IntegrationFetch,
            IntegrationFetch.IntegrationFetch.of({
              fetch: IntegrationFetch.makeGuardedFetch(fake.send, PUBLIC),
            }),
          ),
        ),
      ),
    );
    const auth = Context.get(context, IntegrationAuth.IntegrationAuth);
    const settings = Context.get(context, ServerSettings.ServerSettingsService);
    return { fake, secrets, auth, settings };
  });

const web: IntegrationBeginConnectInput["client"] = { kind: "web", origin: "https://box.example" };

const connectLinear = (env: Effect.Success<ReturnType<typeof setup>>) =>
  Effect.gen(function* () {
    const begun = yield* env.auth.beginConnect({ catalogId: "linear", client: web });
    return yield* env.auth.completeConnect({
      flowId: begun.flowId,
      callbackUrl: env.fake.approve(begun.authorizationUrl),
    });
  });

const reasonOf = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

it("the bundled catalog decodes strictly and leaves out unverified vendors", () => {
  const decode = Schema.decodeUnknownSync(Schema.Array(IntegrationCatalogEntry), {
    onExcessProperty: "error",
  });
  const entries = decode(catalogJson);
  expect(entries).toHaveLength(25);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(25);
  for (const left of ["figma", "square", "atlassian"]) {
    expect(entries.some((entry) => entry.id.includes(left))).toBe(false);
  }
  expect(IntegrationAuth.decodeCatalog([...catalogJson, { id: "broken" }])).toHaveLength(25);
});

it.effect("connects through discovery, registration and PKCE, and stores the tokens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      const begun = yield* env.auth.beginConnect({ catalogId: "linear", client: web });
      const authorization = new URL(begun.authorizationUrl);
      expect(begun.mode).toBe("server");
      expect(begun.redirectUri).toBe("https://box.example/oauth/integrations/callback");
      expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
        client_id: "dcr-client",
        code_challenge_method: "S256",
        resource: MCP,
        scope: "read write",
        redirect_uri: begun.redirectUri,
      });
      // The 401 challenge names the metadata, so no well-known guessing happens.
      expect(env.fake.requests.slice(0, 4)).toEqual([
        `POST ${MCP}`,
        "GET https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
        `GET ${AS}/.well-known/oauth-authorization-server`,
        `POST ${AS}/register`,
      ]);
      expect((yield* env.auth.state).integrations).toEqual([
        expect.objectContaining({ name: "linear", status: "connecting" }),
      ]);

      const view = yield* env.auth.completeConnect({
        flowId: begun.flowId,
        callbackUrl: env.fake.approve(begun.authorizationUrl),
      });
      expect(view).toMatchObject({ name: "linear", status: "connected", expiresAt: 3_600_000 });
      expect(JSON.parse(env.secrets.text("integration-token-linear")!)).toMatchObject({
        access: "at-1",
        refresh: "rt-1",
        authorizationServer: AS,
        resource: MCP,
      });
      expect((yield* env.settings.getSettings).mcpServers.linear).toEqual({
        enabled: true,
        transport: "http",
        url: MCP,
        headers: {},
        integration: { catalogId: "linear", auth: "oauth", availability: "assistants" },
      });
      expect(yield* env.auth.accessToken("linear")).toBe("at-1");

      yield* TestClock.adjust(600_001);
      const [after] = (yield* env.auth.state).integrations;
      expect(after).toMatchObject({ name: "linear", status: "connected" });
      expect(after?.lastError).toBeUndefined();
    }),
  ),
);

it.effect(
  "without a challenge, discovery tries the path-aware well-knowns before the root ones",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const env = yield* setup({
          challenge: false,
          prmAtRoot: true,
          asPath: "/tenant",
          metadataAt: "oidc-append",
        });
        yield* env.auth.beginConnect({ catalogId: "linear", client: web });
        expect(env.fake.requests.slice(0, 6)).toEqual([
          `POST ${MCP}`,
          "GET https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
          "GET https://mcp.linear.app/.well-known/oauth-protected-resource",
          `GET ${AS}/.well-known/oauth-authorization-server/tenant`,
          `GET ${AS}/.well-known/openid-configuration/tenant`,
          `GET ${AS}/tenant/.well-known/openid-configuration`,
        ]);
      }),
    ),
);

it.effect("refuses an authorization server whose metadata names another issuer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ issuer: "https://other.test" });
      expect(yield* reasonOf(env.auth.beginConnect({ catalogId: "linear", client: web }))).toBe(
        "discovery-failed",
      );
    }),
  ),
);

it.effect("PKCE: refused unless advertised, except for a flagged entry on the user's own app", () =>
  Effect.gen(function* () {
    const cases = [
      { catalogId: "linear", methods: null, expected: "pkce-unsupported" },
      { catalogId: "linear", methods: ["plain"], expected: "pkce-unsupported" },
      { catalogId: "google-calendar", methods: null, expected: "pkce-unsupported" },
      { catalogId: "microsoft-365", methods: null, expected: "ok" },
      { catalogId: "microsoft-365", methods: ["plain"], expected: "pkce-unsupported" },
    ] as const;
    for (const { catalogId, methods, expected } of cases) {
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const env = yield* setup({ pkceMethods: methods });
          for (const clientGroup of ["google", "microsoft"]) {
            yield* env.auth.saveOwnApp({ clientGroup, clientId: `${clientGroup}-app` });
          }
          return yield* env.auth
            .beginConnect({ catalogId, client: web })
            .pipe(
              Effect.as("ok"),
              Effect.catchTags({ IntegrationError: (error) => Effect.succeed(error.reason) }),
            );
        }),
      );
      expect({ catalogId, methods, outcome }).toEqual({ catalogId, methods, outcome: expected });
    }
  }),
);

it.effect("state is single use", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      const begun = yield* env.auth.beginConnect({ catalogId: "linear", client: web });
      const callbackUrl = env.fake.approve(begun.authorizationUrl);
      yield* env.auth.completeConnect({ callbackUrl });
      expect(yield* reasonOf(env.auth.completeConnect({ callbackUrl }))).toBe("sign-in-expired");
      expect(
        yield* reasonOf(
          env.auth.completeConnect({ callbackUrl: `${begun.redirectUri}?code=x&state=forged` }),
        ),
      ).toBe("sign-in-expired");
    }),
  ),
);

it.effect("state expires after ten minutes and stores nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      const begun = yield* env.auth.beginConnect({ catalogId: "linear", client: web });
      expect(begun.expiresAt).toBe(600_000);
      const callbackUrl = env.fake.approve(begun.authorizationUrl);
      yield* TestClock.adjust(600_001);
      expect((yield* env.auth.state).integrations).toEqual([
        expect.objectContaining({ name: "linear", status: "error", lastError: "sign-in-expired" }),
      ]);
      expect(yield* reasonOf(env.auth.completeConnect({ callbackUrl }))).toBe("sign-in-expired");
      expect(env.secrets.text("integration-token-linear")).toBeUndefined();
    }),
  ),
);

it.effect("rejects a mismatched or missing iss, and a flow id from another sign-in", () =>
  Effect.gen(function* () {
    const cases = [
      { extra: { iss: "https://evil.test" }, flowId: undefined, issSupported: true },
      { extra: {}, flowId: "another-flow", issSupported: true },
    ];
    for (const { extra, flowId, issSupported } of cases) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const env = yield* setup({ issSupported });
          const begun = yield* env.auth.beginConnect({ catalogId: "linear", client: web });
          const callbackUrl = env.fake.approve(begun.authorizationUrl, extra);
          expect(
            yield* reasonOf(
              env.auth.completeConnect({ callbackUrl, ...(flowId ? { flowId } : {}) }),
            ),
          ).toBe("sign-in-expired");
          expect(env.secrets.text("integration-token-linear")).toBeUndefined();
        }),
      );
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const env = yield* setup({ issSupported: true });
        const begun = yield* env.auth.beginConnect({ catalogId: "linear", client: web });
        const callback = new URL(env.fake.approve(begun.authorizationUrl));
        callback.searchParams.delete("iss");
        expect(yield* reasonOf(env.auth.completeConnect({ callbackUrl: callback.href }))).toBe(
          "sign-in-expired",
        );
      }),
    );
  }),
);

it.effect("a denied sign-in or a malformed address stores nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      const begun = yield* env.auth.beginConnect({ catalogId: "linear", client: web });
      const denied = new URL(env.fake.approve(begun.authorizationUrl, { error: "access_denied" }));
      denied.searchParams.delete("code");
      expect(
        yield* env.auth.completeConnect({ callbackUrl: denied.href }).pipe(Effect.flip),
      ).toEqual(expect.objectContaining({ reason: "sign-in-denied", oauthError: "access_denied" }));
      expect(yield* reasonOf(env.auth.completeConnect({ callbackUrl: "not a url" }))).toBe(
        "invalid-callback",
      );
      expect(
        yield* reasonOf(env.auth.completeConnect({ callbackUrl: "https://x.test/?code=1" })),
      ).toBe("invalid-callback");
      expect(env.secrets.text("integration-token-linear")).toBeUndefined();
    }),
  ),
);

it.effect("the server route reports the outcome without revealing it, and cancel ends a flow", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      const mobile = yield* env.auth.beginConnect({
        catalogId: "linear",
        client: { kind: "mobile", origin: "https://box.example", returnScheme: "t3code" },
      });
      const params = new URL(env.fake.approve(mobile.authorizationUrl)).searchParams;
      expect(yield* env.auth.completeCallback(params)).toEqual({
        connected: true,
        serviceName: "Linear",
        returnScheme: "t3code",
      });
      expect(yield* env.auth.completeCallback(params)).toEqual({
        connected: false,
        serviceName: undefined,
        returnScheme: undefined,
      });

      const begun = yield* env.auth.beginConnect({ catalogId: "linear", client: web });
      yield* env.auth.cancelConnect({ flowId: begun.flowId });
      yield* env.auth.cancelConnect({ flowId: begun.flowId });
      expect(
        yield* reasonOf(
          env.auth.completeConnect({ callbackUrl: env.fake.approve(begun.authorizationUrl) }),
        ),
      ).toBe("sign-in-expired");
    }),
  ),
);

it.effect("chooses the callback by connection mode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      const loopback = (yield* env.auth.state).loopbackRedirectUri;
      expect(loopback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/integrations\/callback$/);
      const cases: ReadonlyArray<
        readonly [string, IntegrationBeginConnectInput["client"], string, string]
      > = [
        ["linear", { kind: "web", origin: "https://box.example" }, "server", "https://box.example"],
        [
          "linear",
          { kind: "web", origin: "http://127.0.0.1:3773" },
          "server",
          "http://127.0.0.1:3773",
        ],
        ["linear", { kind: "web", origin: "http://192.168.1.5:3773" }, "paste", loopback],
        ["linear", { kind: "web", origin: "https://box.example/app?x" }, "paste", loopback],
        ["linear", { kind: "web", origin: "::not a url" }, "paste", loopback],
        [
          "linear",
          { kind: "desktop", origin: "https://box.example", loopback: true },
          "loopback",
          loopback,
        ],
        [
          "linear",
          { kind: "mobile", origin: "https://box.example" },
          "server",
          "https://box.example",
        ],
        ["linear", { kind: "mobile", origin: "http://127.0.0.1:3773" }, "paste", loopback],
        ["linear", { kind: "mobile" }, "paste", loopback],
        ["intercom", { kind: "web", origin: "https://box.example" }, "paste", loopback],
      ];
      for (const [catalogId, client, mode, base] of cases) {
        const begun = yield* env.auth.beginConnect({ catalogId, client });
        expect({ client, mode: begun.mode, redirectUri: begun.redirectUri }).toEqual({
          client,
          mode,
          redirectUri: mode === "server" ? `${base}/oauth/integrations/callback` : base,
        });
      }
      const moved = yield* env.auth.beginConnect({
        catalogId: "linear",
        client: { kind: "desktop", loopback: true, loopbackBusy: true },
      });
      expect(moved.redirectUri).not.toBe(loopback);
      expect((yield* env.auth.state).loopbackRedirectUri).toBe(moved.redirectUri);
    }),
  ),
);

it.effect("a paste-mode sign-in completes from the pasted address", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      const begun = yield* env.auth.beginConnect({
        catalogId: "linear",
        client: { kind: "mobile" },
      });
      expect(begun.mode).toBe("paste");
      const pasted = `  ${env.fake.approve(begun.authorizationUrl)}\n`;
      expect(
        yield* env.auth.completeConnect({ flowId: begun.flowId, callbackUrl: pasted }),
      ).toMatchObject({
        status: "connected",
      });
      // Registration is cached per issuer and redirect URI.
      yield* env.auth.beginConnect({ catalogId: "linear", client: { kind: "mobile" } });
      expect(env.fake.requests.filter((request) => request.endsWith("/register"))).toHaveLength(1);
    }),
  ),
);

it.effect("refresh rotates the refresh token, and invalid_grant needs a new sign-in", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      yield* connectLinear(env);
      yield* TestClock.adjust(3_570_000);
      expect(yield* env.auth.accessToken("linear")).toBe("at-2");
      expect(JSON.parse(env.secrets.text("integration-token-linear")!)).toMatchObject({
        access: "at-2",
        refresh: "rt-2",
        expiresAt: 3_570_000 + 3_600_000,
      });
      expect(yield* env.auth.accessToken("linear")).toBe("at-2");

      yield* TestClock.adjust(3_600_000);
      env.fake.rejectRefresh();
      expect(yield* reasonOf(env.auth.accessToken("linear"))).toBe("needs-sign-in");
      const stored = JSON.parse(env.secrets.text("integration-token-linear")!);
      expect(stored).toMatchObject({ needsSignIn: true });
      expect(stored.access).toBeUndefined();
      expect(stored.refresh).toBeUndefined();
      expect((yield* env.auth.state).integrations).toEqual([
        expect.objectContaining({ name: "linear", status: "needs-sign-in" }),
      ]);
      expect(yield* reasonOf(env.auth.accessToken("linear"))).toBe("needs-sign-in");
      expect(yield* reasonOf(env.auth.accessToken("missing"))).toBe("not-connected");
    }),
  ),
);

it.effect("a rejected token refreshes once, even when it has not expired", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      yield* connectLinear(env);
      expect(yield* env.auth.accessToken("linear", "at-1")).toBe("at-2");
      // A second request that saw the same rejection gets the new token, with no second refresh.
      expect(yield* env.auth.accessToken("linear", "at-1")).toBe("at-2");
      expect(env.fake.requests.filter((r) => r === `POST ${AS}/token`)).toHaveLength(2);
      // The refreshed token is refused too: the user must sign in again.
      yield* env.auth.markRejected("linear");
      expect((yield* env.auth.state).integrations).toEqual([
        expect.objectContaining({ name: "linear", status: "needs-sign-in" }),
      ]);
      yield* env.auth.markRejected("linear");
      yield* env.auth.markRejected("missing");
    }),
  ),
);

it.effect(
  "insufficient_scope needs more access, survives refresh and reconnects with the union",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const env = yield* setup();
        yield* connectLinear(env);
        yield* env.auth.markNeedsMoreAccess("linear", "write admin");
        yield* env.auth.markNeedsMoreAccess("missing", "admin");
        const view = () =>
          env.auth.state.pipe(
            Effect.map((state) => state.integrations.find((i) => i.name === "linear")),
          );
        expect(yield* view()).toMatchObject({ status: "needs-more-access" });
        yield* TestClock.adjust(3_570_000);
        expect(yield* env.auth.accessToken("linear")).toBe("at-2");
        expect(yield* view()).toMatchObject({ status: "needs-more-access" });
        const begun = yield* env.auth.beginConnect({ catalogId: "linear", client: web });
        expect(new URL(begun.authorizationUrl).searchParams.get("scope")).toBe("read write admin");
        yield* env.auth.completeConnect({
          flowId: begun.flowId,
          callbackUrl: env.fake.approve(begun.authorizationUrl),
        });
        expect(yield* view()).toMatchObject({ status: "connected" });
      }),
    ),
);

it.effect("availability is the user's to set, and a reconnect keeps it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      yield* connectLinear(env);
      const stored = () =>
        env.settings.getSettings.pipe(
          Effect.map((settings) => {
            const server = settings.mcpServers.linear;
            return server?.transport === "http" ? server.integration?.availability : undefined;
          }),
        );
      expect(yield* stored()).toBe("assistants");
      const view = yield* env.auth.update({ name: "linear", availability: "all" });
      expect(view).toMatchObject({ name: "linear", availability: "all", status: "connected" });
      expect(yield* stored()).toBe("all");
      yield* connectLinear(env);
      expect(yield* stored()).toBe("all");
      yield* env.auth.update({ name: "linear", availability: "assistants" });
      expect(yield* stored()).toBe("assistants");
      expect(yield* reasonOf(env.auth.update({ name: "missing", availability: "all" }))).toBe(
        "not-connected",
      );
    }),
  ),
);

it.effect("an unreachable service shows Error until the next answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      yield* connectLinear(env);
      const view = () =>
        env.auth.state.pipe(
          Effect.map((state) => state.integrations.find((i) => i.name === "linear")),
        );
      yield* env.auth.reportReachable("linear", false);
      expect(yield* view()).toMatchObject({ status: "error", lastError: "unreachable" });
      yield* env.auth.reportReachable("linear", true);
      const back = yield* view();
      expect(back).toMatchObject({ status: "connected" });
      expect(back).not.toHaveProperty("lastError");
      // Signing in again outranks it: the row asks for that, not a retry.
      yield* env.auth.reportReachable("linear", false);
      yield* env.auth.markRejected("linear");
      expect(yield* view()).toMatchObject({ status: "needs-sign-in" });
      yield* env.auth.disconnect({ name: "linear" });
      yield* connectLinear(env);
      expect(yield* view()).toMatchObject({ status: "connected" });
    }),
  ),
);

it("scopeUnion keeps first-seen order and drops blanks", () => {
  expect(IntegrationAuth.scopeUnion("a b", undefined, " b  c ", "")).toBe("a b c");
  expect(IntegrationAuth.scopeUnion()).toBe("");
});

it.effect("disconnect revokes and deletes the tokens, the registration and the server entry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      yield* connectLinear(env);
      const registrations = () =>
        [...env.secrets.values.keys()].filter((key) => key.startsWith("integration-client-"));
      expect(registrations()).toHaveLength(1);
      yield* env.auth.disconnect({ name: "linear" });
      expect(env.fake.revoked).toEqual(["rt-1"]);
      expect(env.secrets.text("integration-token-linear")).toBeUndefined();
      expect(registrations()).toEqual([]);
      expect((yield* env.settings.getSettings).mcpServers.linear).toBeUndefined();
      expect((yield* env.auth.state).integrations).toEqual([]);
      expect(yield* reasonOf(env.auth.disconnect({ name: "linear" }))).toBe("not-connected");
    }),
  ),
);

it.effect(
  "an own app is required, saved once per client group, and removing it disconnects its users",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const env = yield* setup();
        expect(
          yield* reasonOf(env.auth.beginConnect({ catalogId: "google-calendar", client: web })),
        ).toBe("own-app-required");
        expect(yield* reasonOf(env.auth.saveOwnApp({ clientGroup: "nobody", clientId: "x" }))).toBe(
          "unknown-entry",
        );
        expect(yield* reasonOf(env.auth.saveOwnApp({ clientGroup: "google", clientId: " " }))).toBe(
          "invalid-token",
        );
        yield* env.auth.saveOwnApp({
          clientGroup: "google",
          clientId: "g-app",
          clientSecret: "g-secret",
        });
        yield* env.auth.saveOwnApp({ clientGroup: "google", clientId: "g-app-2" });
        expect(JSON.parse(env.secrets.text("integration-app-google")!)).toEqual({
          clientId: "g-app-2",
          clientSecret: "g-secret",
        });
        expect((yield* env.auth.state).ownApps).toEqual([
          { clientGroup: "google", clientId: "g-app-2", hasClientSecret: true },
        ]);

        // The fake serves the same authorization server for every URL, which is enough here.
        for (const catalogId of ["google-calendar", "gmail"]) {
          const begun = yield* env.auth.beginConnect({ catalogId, client: web });
          expect(new URL(begun.authorizationUrl).searchParams.get("client_id")).toBe("g-app-2");
          yield* env.auth.completeConnect({
            callbackUrl: env.fake.approve(begun.authorizationUrl),
          });
        }
        yield* env.auth.saveToken({ catalogId: "notion", token: "notion-token" });
        const pending = yield* env.auth.beginConnect({ catalogId: "google-calendar", client: web });

        yield* env.auth.removeOwnApp({ clientGroup: "google" });
        const servers = (yield* env.settings.getSettings).mcpServers;
        expect(Object.keys(servers)).toEqual(["notion"]);
        expect(env.secrets.text("integration-app-google")).toBeUndefined();
        expect(
          yield* reasonOf(
            env.auth.completeConnect({ callbackUrl: env.fake.approve(pending.authorizationUrl) }),
          ),
        ).toBe("sign-in-expired");

        yield* env.auth.saveOwnApp({ clientGroup: "google", clientId: "g", clientSecret: "s" });
        yield* env.auth.saveOwnApp({ clientGroup: "google", clientId: "g", clientSecret: "" });
        expect(JSON.parse(env.secrets.text("integration-app-google")!)).toEqual({ clientId: "g" });
      }),
    ),
);

it.effect("tokens are saved only for entries that take one, and replace an OAuth sign-in", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      expect(yield* reasonOf(env.auth.saveToken({ catalogId: "sentry", token: "x" }))).toBe(
        "unsupported-auth",
      );
      expect(yield* reasonOf(env.auth.saveToken({ catalogId: "nope", token: "x" }))).toBe(
        "unknown-entry",
      );
      expect(
        yield* reasonOf(env.auth.saveToken({ catalogId: "linear", token: "a\r\nX-Evil: 1" })),
      ).toBe("invalid-token");
      yield* connectLinear(env);
      const view = yield* env.auth.saveToken({ catalogId: "linear", token: " lin_api_key " });
      expect(view).toMatchObject({ name: "linear", auth: "token", status: "connected" });
      expect(env.fake.revoked).toEqual(["rt-1"]);
      expect(JSON.parse(env.secrets.text("integration-token-linear")!)).toEqual({
        kind: "token",
        token: "lin_api_key",
      });
      expect(yield* env.auth.accessToken("linear")).toBe("lin_api_key");
      expect(yield* reasonOf(env.auth.beginConnect({ catalogId: "nope", client: web }))).toBe(
        "unknown-entry",
      );
    }),
  ),
);

it.effect("names an integration around a hand-made server that holds its id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      yield* env.settings.updateSettings({
        mcpServers: {
          linear: { enabled: true, transport: "stdio", command: "linear-mcp", args: [], env: {} },
        },
      });
      expect((yield* connectLinear(env)).name).toBe("linear-2");
      expect((yield* connectLinear(env)).name).toBe("linear-2");
    }),
  ),
);

it.effect("no secret reaches the state payload", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      yield* connectLinear(env);
      yield* env.auth.saveOwnApp({
        clientGroup: "google",
        clientId: "g-app",
        clientSecret: "own-app-secret",
      });
      yield* env.auth.saveToken({ catalogId: "notion", token: "notion-manual-token" });
      const payload = JSON.stringify(yield* env.auth.state);
      for (const secret of [
        "at-1",
        "rt-1",
        "own-app-secret",
        "notion-manual-token",
        "code_verifier",
      ]) {
        expect(payload).not.toContain(secret);
      }
    }),
  ),
);

it.effect("the change stream starts with the state and follows every change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup();
      const subscribed = yield* Deferred.make<void>();
      const fiber = yield* env.auth.changes.pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      yield* env.auth.saveOwnApp({ clientGroup: "slack", clientId: "slack-app" });
      const states = yield* Fiber.join(fiber);
      expect(states.map((state) => state.ownApps.length)).toEqual([0, 1]);
    }),
  ),
);

it.effect("discovery refuses unsafe addresses", () =>
  Effect.gen(function* () {
    for (const authorizationServer of ["http://auth.linear.test", "https://127.0.0.1"]) {
      const reason = yield* Effect.scoped(
        Effect.gen(function* () {
          const env = yield* setup({ authorizationServer });
          return yield* reasonOf(env.auth.beginConnect({ catalogId: "linear", client: web }));
        }),
      );
      expect({ authorizationServer, reason }).toEqual({
        authorizationServer,
        reason: "unsafe-address",
      });
    }
  }),
);

it.effect("opens only http(s) authorization pages", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cases = [
        ["javascript:alert(1)", "discovery-failed"],
        ["ftp://auth.linear.test/authorize", "unsafe-address"],
      ] as const;
      for (const [authorizationEndpoint, expected] of cases) {
        const env = yield* setup({ authorizationEndpoint });
        expect(yield* reasonOf(env.auth.beginConnect({ catalogId: "linear", client: web }))).toBe(
          expected,
        );
      }
    }),
  ),
);

it.effect("refuses open registration where the server offers none", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ registration: false });
      expect(yield* reasonOf(env.auth.beginConnect({ catalogId: "linear", client: web }))).toBe(
        "registration-unavailable",
      );
    }),
  ),
);
