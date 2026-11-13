import {
  INTEGRATIONS_CALLBACK_PATH,
  INTEGRATIONS_LOOPBACK_CALLBACK_PATH,
  IntegrationCatalogEntry,
  IntegrationError,
  type IntegrationBeginConnectInput,
  type IntegrationBeginConnectResult,
  type IntegrationConnectMode,
  type IntegrationErrorReason,
  type IntegrationMakeAvailableResult,
  type IntegrationSaveOwnAppInput,
  type IntegrationUpdateInput,
  type IntegrationView,
  type IntegrationsState,
  type ServerSettings as ServerSettingsValue,
  type T3McpServer,
} from "@t3tools/contracts";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import catalogJson from "./catalog.json" with { type: "json" };
import * as IntegrationDetector from "./IntegrationDetector.ts";
import * as IntegrationFetch from "./IntegrationFetch.ts";

const FLOW_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;
const LOOPBACK_PORT_SECRET = "integration-loopback-port";
const LOOPBACK_PORT_MIN = 49152;
const LOOPBACK_PORT_SPAN = 16383;

const tokenSecret = (name: string) => `integration-token-${name}`;
const appSecret = (clientGroup: string) => `integration-app-${clientGroup}`;

const ClientRef = Schema.Union([
  Schema.Struct({ source: Schema.Literal("dcr"), key: Schema.String }),
  Schema.Struct({ source: Schema.Literal("own-app"), clientGroup: Schema.String }),
]);
type ClientRef = typeof ClientRef.Type;

const TokenRecord = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("oauth"),
    access: Schema.optionalKey(Schema.String),
    refresh: Schema.optionalKey(Schema.String),
    expiresAt: Schema.optionalKey(Schema.Number),
    scope: Schema.optionalKey(Schema.String),
    authorizationServer: Schema.String,
    resource: Schema.String,
    // Authorization server metadata as discovered; it holds endpoints, never credentials.
    metadata: Schema.Record(Schema.String, Schema.Unknown),
    client: ClientRef,
    needsSignIn: Schema.optionalKey(Schema.Boolean),
    // The granted scopes plus what a 403 `insufficient_scope` asked for; the next sign-in asks for all.
    stepUpScope: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("token"), token: Schema.String }),
]);
type TokenRecord = typeof TokenRecord.Type;
type OAuthRecord = Extract<TokenRecord, { kind: "oauth" }>;

const OwnApp = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optionalKey(Schema.String),
});
type OwnApp = typeof OwnApp.Type;

const Registration = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
});

const decodeTokenRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TokenRecord));
const decodeOwnApp = Schema.decodeUnknownOption(Schema.fromJsonString(OwnApp));
const decodeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(Registration));
const decodeCatalogEntry = Schema.decodeUnknownOption(IntegrationCatalogEntry);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const encodeJson = (value: unknown) => textEncoder.encode(JSON.stringify(value));

/** Space-separated scopes, deduplicated in first-seen order. */
export const scopeUnion = (...scopes: ReadonlyArray<string | undefined>): string =>
  [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/) ?? []).filter(Boolean))].join(" ");

/** Catalog entries that fail to decode are skipped, never hiding the others. */
export const decodeCatalog = (
  raw: ReadonlyArray<unknown>,
): ReadonlyArray<IntegrationCatalogEntry> =>
  raw.flatMap((entry) => Option.toArray(decodeCatalogEntry(entry)));

// Mirrors the SDK's comparison: parsed URLs, tolerating one trailing slash.
const issuersMatch = (a: string, b: string) => {
  const [x, y] = [new URL(a).href, new URL(b).href];
  return x === y || x === `${y}/` || y === `${x}/`;
};

const isLoopbackHost = (host: string) =>
  host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);

/** The client's server origin, when the browser can come back to `/oauth/integrations/callback` on it. */
const serverCallbackOrigin = (
  client: IntegrationBeginConnectInput["client"],
): string | undefined => {
  if (client.origin === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(client.origin);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return undefined;
  }
  if (url.protocol === "https:") return url.origin;
  // A loopback page is this machine's browser reaching this server; a phone's loopback is not.
  return client.kind === "web" && url.protocol === "http:" && isLoopbackHost(url.hostname)
    ? url.origin
    : undefined;
};

const randomToken = () =>
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const sha256Hex = async (value: string) =>
  Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(value))).toString(
    "hex",
  );

const fail = (reason: IntegrationErrorReason, oauthError?: string) =>
  Effect.fail(
    new IntegrationError({
      reason,
      ...(oauthError === undefined ? {} : { oauthError: oauthError.slice(0, 64) }),
    }),
  );

interface Flow {
  readonly flowId: string;
  readonly state: string;
  readonly name: string;
  readonly entry: IntegrationCatalogEntry;
  readonly authorizationServer: string;
  readonly metadata: AuthorizationServerMetadata;
  readonly resource: string;
  readonly clientInformation: OAuthClientInformationMixed;
  readonly client: ClientRef;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly returnScheme: string | undefined;
  readonly expiresAt: number;
}

export interface IntegrationCallbackOutcome {
  readonly connected: boolean;
  readonly serviceName: string | undefined;
  readonly returnScheme: string | undefined;
}

export class IntegrationAuth extends Context.Service<
  IntegrationAuth,
  {
    readonly catalog: ReadonlyArray<IntegrationCatalogEntry>;
    readonly state: Effect.Effect<IntegrationsState, IntegrationError>;
    readonly changes: Stream.Stream<IntegrationsState, IntegrationError>;
    readonly beginConnect: (
      input: IntegrationBeginConnectInput,
    ) => Effect.Effect<IntegrationBeginConnectResult, IntegrationError>;
    readonly completeConnect: (input: {
      readonly flowId?: string;
      readonly callbackUrl: string;
    }) => Effect.Effect<IntegrationView, IntegrationError>;
    /** The unauthenticated server route; it never fails and never reveals why. */
    readonly completeCallback: (
      params: URLSearchParams,
    ) => Effect.Effect<IntegrationCallbackOutcome>;
    readonly cancelConnect: (input: { readonly flowId: string }) => Effect.Effect<void>;
    readonly disconnect: (input: {
      readonly name: string;
    }) => Effect.Effect<void, IntegrationError>;
    readonly saveToken: (input: {
      readonly catalogId: string;
      readonly token: string;
    }) => Effect.Effect<IntegrationView, IntegrationError>;
    readonly saveOwnApp: (
      input: IntegrationSaveOwnAppInput,
    ) => Effect.Effect<void, IntegrationError>;
    readonly removeOwnApp: (input: {
      readonly clientGroup: string;
    }) => Effect.Effect<void, IntegrationError>;
    /**
     * The upstream credential, refreshed when it expires within a minute, or when `rejected` (a
     * token the upstream just refused) is still the stored one. For the proxy only.
     */
    readonly accessToken: (
      name: string,
      rejected?: string,
    ) => Effect.Effect<string, IntegrationError>;
    /** Sets who gets the integration: assistants only (the default) or every thread. */
    readonly update: (
      input: IntegrationUpdateInput,
    ) => Effect.Effect<IntegrationView, IntegrationError>;
    /** Copies a server detected in Claude Code or Codex into T3's MCP servers, on consent. */
    readonly makeAvailable: (input: {
      readonly detectedId: string;
    }) => Effect.Effect<IntegrationMakeAvailableResult, IntegrationError>;
    /** The proxy's last upstream outcome; unreachable shows as Error until the next answer. */
    readonly reportReachable: (name: string, reachable: boolean) => Effect.Effect<void>;
    /** The upstream refused a fresh token: the user must sign in again. */
    readonly markRejected: (name: string) => Effect.Effect<void, IntegrationError>;
    /** A 403 `insufficient_scope`: Reconnect asks for the granted and the challenged scopes. */
    readonly markNeedsMoreAccess: (
      name: string,
      scope: string | undefined,
    ) => Effect.Effect<void, IntegrationError>;
  }
>()("t3/integrations/IntegrationAuth") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const { fetch } = yield* IntegrationFetch.IntegrationFetch;
  const detector = yield* IntegrationDetector.IntegrationDetector;
  const serviceScope = yield* Effect.scope;
  const catalog = decodeCatalog(catalogJson);
  if (catalog.length !== catalogJson.length) {
    yield* Effect.logWarning("Integration catalog entries skipped", {
      skipped: catalogJson.length - catalog.length,
    });
  }
  const changesPubSub = yield* PubSub.unbounded<void>();
  // ponytail: one lock for every refresh; per-integration locks if the proxy serializes visibly.
  const refreshLock = yield* Semaphore.make(1);
  const flows = new Map<string, Flow>();
  // The last failed sign-in per integration name, until the next attempt or success.
  const failures = new Map<string, { catalogId: string; reason: IntegrationErrorReason }>();
  const unreachable = new Set<string>();

  const publish = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

  const storage = <A, E, R>(effect: Effect.Effect<A, E, R>, stage: string) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning("Integration storage failed", { stage, cause })),
      Effect.mapError(() => new IntegrationError({ reason: "storage-failed" })),
    );

  const getSettings = storage(serverSettings.getSettings, "read-settings");
  const readSecret = (name: string) =>
    storage(secrets.get(name), "read-secret").pipe(
      Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
    );
  const readRecord = (name: string) =>
    readSecret(tokenSecret(name)).pipe(Effect.map(Option.flatMap(decodeTokenRecord)));
  const writeRecord = (name: string, record: TokenRecord) =>
    storage(secrets.set(tokenSecret(name), encodeJson(record)), "write-token");
  const readOwnApp = (clientGroup: string) =>
    readSecret(appSecret(clientGroup)).pipe(Effect.map(Option.flatMap(decodeOwnApp)));

  const entryById = (catalogId: string) => {
    const entry = catalog.find((candidate) => candidate.id === catalogId);
    return entry === undefined ? fail("unknown-entry") : Effect.succeed(entry);
  };

  const integrationOf = (server: T3McpServer | undefined) =>
    server?.transport === "http" ? server.integration : undefined;

  const resolveName = (servers: ServerSettingsValue["mcpServers"], catalogId: string) => {
    for (let index = 1; ; index++) {
      const name = index === 1 ? catalogId : `${catalogId}-${index}`;
      const server = servers[name];
      if (server === undefined || integrationOf(server)?.catalogId === catalogId) return name;
    }
  };

  const loopbackPort = Effect.fn("IntegrationAuth.loopbackPort")(function* (moveOff?: boolean) {
    const stored = Option.flatMap(yield* readSecret(LOOPBACK_PORT_SECRET), (text) => {
      const port = Number.parseInt(text, 10);
      return Number.isInteger(port) && port > 1024 && port < 65536
        ? Option.some(port)
        : Option.none();
    });
    if (Option.isSome(stored) && !moveOff) return stored.value;
    let port = yield* Random.nextIntBetween(
      LOOPBACK_PORT_MIN,
      LOOPBACK_PORT_MIN + LOOPBACK_PORT_SPAN,
    );
    if (Option.isSome(stored) && port === stored.value) port += 1;
    yield* storage(
      secrets.set(LOOPBACK_PORT_SECRET, textEncoder.encode(String(port))),
      "write-loopback-port",
    );
    return port;
  });
  const loopbackRedirectUri = (port: number) =>
    `http://127.0.0.1:${port}${INTEGRATIONS_LOOPBACK_CALLBACK_PATH}`;

  const viewOf = Effect.fn("IntegrationAuth.viewOf")(function* (
    name: string,
    integration: NonNullable<ReturnType<typeof integrationOf>>,
  ): Effect.fn.Return<IntegrationView, IntegrationError> {
    const lastError = failures.get(name)?.reason;
    const base = {
      name,
      catalogId: integration.catalogId,
      auth: integration.auth,
      availability: integration.availability,
      ...(lastError === undefined ? {} : { lastError }),
    };
    const connecting = [...flows.values()].some((flow) => flow.name === name);
    const record = yield* readRecord(name).pipe(Effect.option);
    if (Option.isNone(record)) {
      return { ...base, status: "error", lastError: "storage-failed" } as const;
    }
    const stored = record.value;
    if (connecting) return { ...base, status: "connecting" } as const;
    if (Option.isNone(stored)) return { ...base, status: "needs-sign-in" } as const;
    const connected = unreachable.has(name)
      ? ({ status: "error", lastError: "unreachable" } as const)
      : ({ status: "connected" } as const);
    if (stored.value.kind === "token") return { ...base, ...connected } as const;
    const oauth = stored.value;
    return {
      ...base,
      ...(oauth.needsSignIn
        ? { status: "needs-sign-in" as const }
        : oauth.stepUpScope === undefined
          ? connected
          : { status: "needs-more-access" as const }),
      ...(oauth.expiresAt === undefined ? {} : { expiresAt: oauth.expiresAt }),
      ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
    } as const;
  });

  const ownAppGroups = [
    ...new Set(
      catalog.flatMap((entry) =>
        entry.auth.kind === "oauth" && entry.auth.registration === "own-app"
          ? [entry.auth.clientGroup]
          : [],
      ),
    ),
  ];

  const state = Effect.gen(function* () {
    const settings = yield* getSettings;
    const integrations: Array<IntegrationView> = [];
    const named = new Set<string>();
    for (const [name, server] of Object.entries(settings.mcpServers)) {
      const integration = integrationOf(server);
      if (integration === undefined) continue;
      named.add(name);
      integrations.push(yield* viewOf(name, integration));
    }
    // A first sign-in has no server entry until it completes.
    for (const flow of flows.values()) {
      if (named.has(flow.name)) continue;
      named.add(flow.name);
      integrations.push({
        name: flow.name,
        catalogId: flow.entry.id,
        auth: "oauth",
        status: "connecting",
        availability: "assistants",
      });
    }
    for (const [name, failure] of failures) {
      if (named.has(name)) continue;
      integrations.push({
        name,
        catalogId: failure.catalogId,
        auth: "oauth",
        status: "error",
        lastError: failure.reason,
        availability: "assistants",
      });
    }
    const ownApps = [];
    for (const clientGroup of ownAppGroups) {
      const app = yield* readOwnApp(clientGroup);
      if (Option.isSome(app)) {
        ownApps.push({
          clientGroup,
          clientId: app.value.clientId,
          hasClientSecret: app.value.clientSecret !== undefined,
        });
      }
    }
    const detection = yield* detector.detect;
    return {
      catalog,
      integrations,
      ownApps,
      loopbackRedirectUri: loopbackRedirectUri(yield* loopbackPort()),
      detected: detection.detected,
      detectionSources: detection.sources,
    } satisfies IntegrationsState;
  }).pipe(Effect.withSpan("IntegrationAuth.state"));

  const changes = Stream.unwrap(
    Effect.gen(function* () {
      const own = yield* PubSub.subscribe(changesPubSub);
      const settingsChanges = yield* serverSettings.subscribeChanges;
      return Stream.concat(
        Stream.succeed(undefined),
        Stream.mergeAll(
          [
            Stream.fromSubscription(own),
            settingsChanges.pipe(Stream.map(() => undefined)),
            detector.changes,
          ],
          { concurrency: "unbounded" },
        ),
      ).pipe(Stream.mapEffect(() => state));
    }),
  );

  // Every outside call goes through the guarded fetch; an unsafe address wins over other failures.
  const outside = <A>(
    attempt: () => Promise<A>,
    reason: IntegrationErrorReason,
  ): Effect.Effect<A, IntegrationError> =>
    Effect.tryPromise({
      try: attempt,
      catch: (cause) =>
        new IntegrationError({
          reason: cause instanceof IntegrationFetch.UnsafeAddressError ? "unsafe-address" : reason,
          ...(cause instanceof OAuthError ? { oauthError: cause.errorCode.slice(0, 64) } : {}),
        }),
    });

  type Challenge = ReturnType<typeof extractWWWAuthenticateParams>;
  const discover = Effect.fn("IntegrationAuth.discover")(function* (serverUrl: string) {
    // An unauthenticated request names the metadata and scope in its 401 challenge.
    const challenge = yield* outside(
      () =>
        fetch(serverUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "T3 Code", version: "1" },
            },
          }),
        }).then((response): Challenge => {
          void response.body?.cancel();
          return response.status === 401 ? extractWWWAuthenticateParams(response) : {};
        }),
      "discovery-failed",
    ).pipe(
      Effect.catchTags({
        IntegrationError: (error) =>
          error.reason === "unsafe-address" ? Effect.fail(error) : Effect.succeed<Challenge>({}),
      }),
    );
    const resourceMetadata = yield* outside(
      () =>
        discoverOAuthProtectedResourceMetadata(
          serverUrl,
          challenge.resourceMetadataUrl === undefined
            ? {}
            : { resourceMetadataUrl: challenge.resourceMetadataUrl },
          fetch,
        ),
      "discovery-failed",
    );
    const authorizationServer = resourceMetadata.authorization_servers?.[0];
    if (authorizationServer === undefined) return yield* fail("discovery-failed");
    if (
      resourceMetadata.resource !== undefined &&
      !checkResourceAllowed({
        requestedResource: serverUrl,
        configuredResource: resourceMetadata.resource,
      })
    ) {
      return yield* fail("discovery-failed");
    }
    const metadata = yield* outside(
      () => discoverAuthorizationServerMetadata(authorizationServer, { fetchFn: fetch }),
      "discovery-failed",
    );
    if (metadata === undefined || !issuersMatch(metadata.issuer, authorizationServer)) {
      return yield* fail("discovery-failed");
    }
    return {
      authorizationServer,
      metadata,
      resource: resourceMetadata.resource ?? resourceUrlFromServerUrl(serverUrl).href,
      scope:
        challenge.scope ??
        (resourceMetadata.scopes_supported?.length
          ? resourceMetadata.scopes_supported.join(" ")
          : undefined),
    };
  });

  const registration = Effect.fn("IntegrationAuth.registration")(function* (input: {
    readonly entry: IntegrationCatalogEntry;
    readonly authorizationServer: string;
    readonly metadata: AuthorizationServerMetadata;
    readonly redirectUri: string;
    readonly loopback: boolean;
  }) {
    const { entry, metadata } = input;
    if (entry.auth.kind === "oauth" && entry.auth.registration === "own-app") {
      const clientGroup = entry.auth.clientGroup;
      const app = yield* readOwnApp(clientGroup);
      if (Option.isNone(app)) return yield* fail("own-app-required");
      return {
        client: { source: "own-app", clientGroup } as ClientRef,
        clientInformation: {
          client_id: app.value.clientId,
          ...(app.value.clientSecret === undefined
            ? {}
            : { client_secret: app.value.clientSecret }),
        } as OAuthClientInformationMixed,
      };
    }
    // CIMD needs a hosted client document (P7), so open registration is the only automatic path.
    const key = `integration-client-${(yield* Effect.promise(() =>
      sha256Hex(`${metadata.issuer}\n${input.redirectUri}`),
    )).slice(0, 32)}`;
    const cached = Option.flatMap(yield* readSecret(key), decodeRegistration);
    if (Option.isSome(cached)) {
      return {
        client: { source: "dcr", key } as ClientRef,
        clientInformation: cached.value as OAuthClientInformationMixed,
      };
    }
    if (metadata.registration_endpoint === undefined)
      return yield* fail("registration-unavailable");
    // MCP 2026-07-28: native for loopback redirects, web for HTTPS ones (not in the SDK's type yet).
    const applicationType = { application_type: input.loopback ? "native" : "web" };
    const registered = yield* outside(
      () =>
        registerClient(input.authorizationServer, {
          metadata,
          clientMetadata: {
            client_name: "T3 Code",
            redirect_uris: [input.redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            ...applicationType,
          },
          fetchFn: fetch,
        }),
      "registration-failed",
    );
    yield* storage(secrets.set(key, encodeJson(registered)), "write-registration");
    return { client: { source: "dcr", key } as ClientRef, clientInformation: registered };
  });

  const beginConnect: IntegrationAuth["Service"]["beginConnect"] = Effect.fn(
    "IntegrationAuth.beginConnect",
  )(function* (input) {
    const entry = yield* entryById(input.catalogId);
    if (
      entry.server.transport !== "http" ||
      entry.auth.kind !== "oauth" ||
      entry.availability === "unavailable"
    ) {
      return yield* fail("unsupported-auth");
    }
    const auth = entry.auth;
    const settings = yield* getSettings;
    const name = resolveName(settings.mcpServers, entry.id);
    const port = yield* loopbackPort(input.client.loopbackBusy === true);
    const origin =
      entry.redirect === "loopback-only" ? undefined : serverCallbackOrigin(input.client);
    const mode: IntegrationConnectMode =
      origin !== undefined && (input.client.kind === "web" || !input.client.loopback)
        ? "server"
        : input.client.loopback
          ? "loopback"
          : "paste";
    const redirectUri =
      mode === "server" ? `${origin}${INTEGRATIONS_CALLBACK_PATH}` : loopbackRedirectUri(port);

    const discovered = yield* discover(entry.server.url);
    const methods = discovered.metadata.code_challenge_methods_supported;
    const assumeS256 = auth.registration === "own-app" && auth.pkce === "assume-s256";
    if (methods === undefined ? !assumeS256 : !methods.includes("S256")) {
      return yield* fail("pkce-unsupported");
    }
    const registered = yield* registration({
      entry,
      authorizationServer: discovered.authorizationServer,
      metadata: discovered.metadata,
      redirectUri,
      loopback: mode !== "server",
    });
    const state = randomToken();
    const previous = Option.getOrUndefined(yield* readRecord(name));
    const stepUp = previous?.kind === "oauth" ? previous.stepUpScope : undefined;
    const scope = scopeUnion(discovered.scope ?? entry.scopes?.join(" "), stepUp) || undefined;
    const started = yield* outside(
      () =>
        startAuthorization(discovered.authorizationServer, {
          metadata: discovered.metadata,
          clientInformation: registered.clientInformation,
          redirectUrl: redirectUri,
          state,
          resource: discovered.resource,
          ...(scope ? { scope } : {}),
        }),
      "discovery-failed",
    );
    const authorizationUrl = started.authorizationUrl;
    if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
      return yield* fail("unsafe-address");
    }
    const expiresAt = (yield* Clock.currentTimeMillis) + FLOW_TTL_MS;
    const flowId = randomToken();
    const flow: Flow = {
      flowId,
      state,
      name,
      entry,
      authorizationServer: discovered.authorizationServer,
      metadata: discovered.metadata,
      resource: discovered.resource,
      clientInformation: registered.clientInformation,
      client: registered.client,
      codeVerifier: started.codeVerifier,
      redirectUri,
      returnScheme: input.client.returnScheme,
      expiresAt,
    };
    flows.set(state, flow);
    failures.delete(name);
    // An abandoned sign-in ends on its own, so no client keeps showing it as in progress.
    yield* Effect.sleep(Duration.millis(FLOW_TTL_MS)).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (flows.get(state) !== flow) return Effect.void;
          flows.delete(state);
          failures.set(name, { catalogId: entry.id, reason: "sign-in-expired" });
          return publish;
        }),
      ),
      Effect.forkIn(serviceScope),
    );
    yield* publish;
    return {
      flowId,
      name,
      authorizationUrl: authorizationUrl.href,
      mode,
      redirectUri,
      expiresAt,
    };
  });

  const upsertServer = Effect.fn("IntegrationAuth.upsertServer")(function* (
    name: string,
    entry: IntegrationCatalogEntry,
    auth: "oauth" | "token",
  ) {
    if (entry.server.transport !== "http") return yield* fail("unsupported-auth");
    const existing = (yield* getSettings).mcpServers[name];
    yield* storage(
      serverSettings.updateSettings({
        mcpServers: {
          [name]: {
            enabled: existing?.enabled ?? true,
            transport: "http",
            url: entry.server.url,
            headers: {},
            integration: {
              catalogId: entry.id,
              auth,
              availability: integrationOf(existing)?.availability ?? "assistants",
            },
          },
        },
      }),
      "write-settings",
    );
  });

  const viewByName = Effect.fn("IntegrationAuth.viewByName")(function* (name: string) {
    const integration = integrationOf((yield* getSettings).mcpServers[name]);
    if (integration === undefined) return yield* fail("not-connected");
    return yield* viewOf(name, integration);
  });

  // Taken synchronously, before any await, so a replayed or concurrent callback finds nothing.
  const takeFlow = Effect.fn("IntegrationAuth.takeFlow")(function* (
    params: URLSearchParams,
    flowId: string | undefined,
  ) {
    const state = params.get("state");
    if (state === null) return yield* fail("invalid-callback");
    const flow = flows.get(state);
    flows.delete(state);
    if (flow === undefined) return yield* fail("sign-in-expired");
    const now = yield* Clock.currentTimeMillis;
    const expired = now > flow.expiresAt;
    return { flow, rejected: expired || (flowId !== undefined && flowId !== flow.flowId) };
  });

  const finishFlow = Effect.fn("IntegrationAuth.finishFlow")(function* (
    flow: Flow,
    params: URLSearchParams,
  ) {
    const iss = params.get("iss");
    // RFC 9207: a mismatched issuer, or a missing one the server promised, is a mix-up.
    // Not in the SDK's metadata type; RFC 9207 §3.
    const issPromised =
      (flow.metadata as Record<string, unknown>).authorization_response_iss_parameter_supported ===
      true;
    if (iss === null ? issPromised : iss !== flow.metadata.issuer) {
      return yield* fail("sign-in-expired");
    }
    const error = params.get("error");
    if (error !== null) return yield* fail("sign-in-denied", error);
    const code = params.get("code");
    if (code === null) return yield* fail("invalid-callback");
    const tokens = yield* outside(
      () =>
        exchangeAuthorization(flow.authorizationServer, {
          metadata: flow.metadata,
          clientInformation: flow.clientInformation,
          authorizationCode: code,
          codeVerifier: flow.codeVerifier,
          redirectUri: flow.redirectUri,
          resource: flow.resource,
          fetchFn: fetch,
        }),
      "exchange-failed",
    );
    const now = yield* Clock.currentTimeMillis;
    // A completed flow may land under a name that was taken while it ran.
    const name = resolveName((yield* getSettings).mcpServers, flow.entry.id);
    yield* writeRecord(name, oauthRecord(flow, tokens, now));
    yield* upsertServer(name, flow.entry, "oauth");
    failures.delete(name);
    yield* publish;
    return yield* viewByName(name);
  });

  const oauthRecord = (
    flow: Pick<OAuthRecord, "authorizationServer" | "resource" | "client"> & {
      readonly metadata: object;
    },
    tokens: OAuthTokens,
    now: number,
  ): OAuthRecord => ({
    kind: "oauth",
    access: tokens.access_token,
    ...(tokens.refresh_token === undefined ? {} : { refresh: tokens.refresh_token }),
    ...(tokens.expires_in === undefined ? {} : { expiresAt: now + tokens.expires_in * 1000 }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    authorizationServer: flow.authorizationServer,
    resource: flow.resource,
    metadata: { ...flow.metadata },
    client: flow.client,
  });

  const complete = Effect.fn("IntegrationAuth.complete")(function* (
    params: URLSearchParams,
    flowId: string | undefined,
  ) {
    const { flow, rejected } = yield* takeFlow(params, flowId);
    return yield* (rejected ? fail("sign-in-expired") : finishFlow(flow, params)).pipe(
      Effect.tapError((error) =>
        Effect.sync(() =>
          failures.set(flow.name, { catalogId: flow.entry.id, reason: error.reason }),
        ).pipe(Effect.andThen(publish)),
      ),
      Effect.map((view) => ({ view, flow })),
    );
  });

  const completeConnect: IntegrationAuth["Service"]["completeConnect"] = Effect.fn(
    "IntegrationAuth.completeConnect",
  )(function* (input) {
    const params = yield* Effect.try({
      try: () => new URL(input.callbackUrl.trim()).searchParams,
      catch: () => new IntegrationError({ reason: "invalid-callback" }),
    });
    return (yield* complete(params, input.flowId)).view;
  });

  const completeCallback: IntegrationAuth["Service"]["completeCallback"] = (params) => {
    const pending = flows.get(params.get("state") ?? "");
    return complete(params, undefined).pipe(
      Effect.match({
        onSuccess: ({ flow }) => ({
          connected: true,
          serviceName: flow.entry.name,
          returnScheme: flow.returnScheme,
        }),
        onFailure: () => ({
          connected: false,
          serviceName: pending?.entry.name,
          returnScheme: pending?.returnScheme,
        }),
      }),
    );
  };

  const cancelConnect: IntegrationAuth["Service"]["cancelConnect"] = Effect.fn(
    "IntegrationAuth.cancelConnect",
  )(function* ({ flowId }) {
    let removed = false;
    for (const [state, flow] of flows) {
      if (flow.flowId === flowId) removed = flows.delete(state);
    }
    if (removed) yield* publish;
  });

  const clientInformationFor = Effect.fn("IntegrationAuth.clientInformationFor")(function* (
    client: ClientRef,
  ) {
    if (client.source === "own-app") {
      return Option.map(
        yield* readOwnApp(client.clientGroup),
        (app): OAuthClientInformationMixed => ({
          client_id: app.clientId,
          ...(app.clientSecret === undefined ? {} : { client_secret: app.clientSecret }),
        }),
      );
    }
    return Option.map(
      Option.flatMap(yield* readSecret(client.key), decodeRegistration),
      (registration) => registration as OAuthClientInformationMixed,
    );
  });

  const revoke = Effect.fn("IntegrationAuth.revoke")(function* (record: OAuthRecord) {
    const endpoint = record.metadata.revocation_endpoint;
    const token = record.refresh ?? record.access;
    if (typeof endpoint !== "string" || token === undefined) return;
    const client = yield* clientInformationFor(record.client);
    if (Option.isNone(client)) return;
    const body = new URLSearchParams({
      token,
      token_type_hint: record.refresh === undefined ? "access_token" : "refresh_token",
      client_id: client.value.client_id,
    });
    if (client.value.client_secret !== undefined) {
      body.set("client_secret", client.value.client_secret);
    }
    yield* outside(
      () =>
        fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        }).then((response) => void response.body?.cancel()),
      "storage-failed",
    ).pipe(
      Effect.catchTags({
        IntegrationError: (error) =>
          Effect.logWarning("Integration token revocation failed", { reason: error.reason }),
      }),
    );
  });

  // Revokes and deletes everything stored for one integration; the server entry stays.
  const purgeSecrets = Effect.fn("IntegrationAuth.purgeSecrets")(function* (name: string) {
    const record = yield* readRecord(name);
    if (Option.isSome(record) && record.value.kind === "oauth") {
      yield* revoke(record.value);
      if (record.value.client.source === "dcr") {
        yield* storage(secrets.remove(record.value.client.key), "remove-registration");
      }
    }
    yield* storage(secrets.remove(tokenSecret(name)), "remove-token");
  });

  const disconnect: IntegrationAuth["Service"]["disconnect"] = Effect.fn(
    "IntegrationAuth.disconnect",
  )(function* ({ name }) {
    const settings = yield* getSettings;
    if (integrationOf(settings.mcpServers[name]) === undefined) {
      return yield* fail("not-connected");
    }
    yield* purgeSecrets(name);
    yield* storage(
      serverSettings.updateSettings({ mcpServers: { [name]: null } }),
      "write-settings",
    );
    for (const [state, flow] of flows) if (flow.name === name) flows.delete(state);
    failures.delete(name);
    unreachable.delete(name);
    yield* publish;
  });

  const saveToken: IntegrationAuth["Service"]["saveToken"] = Effect.fn("IntegrationAuth.saveToken")(
    function* (input) {
      const entry = yield* entryById(input.catalogId);
      if (entry.auth.kind !== "token" && entry.tokenFallback === undefined) {
        return yield* fail("unsupported-auth");
      }
      const token = input.token.trim();
      // The proxy sends it in a header, so a line break would inject another header.
      if (token.length === 0 || /[\r\n]/.test(token)) return yield* fail("invalid-token");
      const name = resolveName((yield* getSettings).mcpServers, entry.id);
      yield* purgeSecrets(name);
      yield* writeRecord(name, { kind: "token", token });
      yield* upsertServer(name, entry, "token");
      failures.delete(name);
      yield* publish;
      return yield* viewByName(name);
    },
  );

  const saveOwnApp: IntegrationAuth["Service"]["saveOwnApp"] = Effect.fn(
    "IntegrationAuth.saveOwnApp",
  )(function* (input) {
    if (!ownAppGroups.includes(input.clientGroup)) return yield* fail("unknown-entry");
    const clientId = input.clientId.trim();
    if (clientId.length === 0 || /[\r\n]/.test(clientId)) return yield* fail("invalid-token");
    const existing = yield* readOwnApp(input.clientGroup);
    const clientSecret =
      input.clientSecret === undefined
        ? Option.getOrUndefined(existing)?.clientSecret
        : input.clientSecret.trim() || undefined;
    const app: OwnApp = { clientId, ...(clientSecret === undefined ? {} : { clientSecret }) };
    yield* storage(secrets.set(appSecret(input.clientGroup), encodeJson(app)), "write-app");
    yield* publish;
  });

  const removeOwnApp: IntegrationAuth["Service"]["removeOwnApp"] = Effect.fn(
    "IntegrationAuth.removeOwnApp",
  )(function* ({ clientGroup }) {
    const usesGroup = (catalogId: string) =>
      catalog.some(
        (entry) =>
          entry.id === catalogId &&
          entry.auth.kind === "oauth" &&
          entry.auth.registration === "own-app" &&
          entry.auth.clientGroup === clientGroup,
      );
    for (const [name, server] of Object.entries((yield* getSettings).mcpServers)) {
      const integration = integrationOf(server);
      if (integration !== undefined && usesGroup(integration.catalogId)) {
        yield* disconnect({ name });
      }
    }
    for (const [state, flow] of flows) {
      if (flow.client.source === "own-app" && flow.client.clientGroup === clientGroup) {
        flows.delete(state);
      }
    }
    yield* storage(secrets.remove(appSecret(clientGroup)), "remove-app");
    yield* publish;
  });

  const markNeedsSignIn = (name: string, record: OAuthRecord) =>
    writeRecord(name, {
      kind: "oauth",
      authorizationServer: record.authorizationServer,
      resource: record.resource,
      metadata: record.metadata,
      client: record.client,
      ...(record.scope === undefined ? {} : { scope: record.scope }),
      needsSignIn: true,
    }).pipe(Effect.andThen(publish), Effect.andThen(fail("needs-sign-in")));

  const refreshLocked = Effect.fn("IntegrationAuth.refresh")(function* (
    name: string,
    rejected: string | undefined,
  ) {
    const stored = yield* readRecord(name);
    if (Option.isNone(stored)) return yield* fail("not-connected");
    const record = stored.value;
    if (record.kind === "token") return record.token;
    if (record.needsSignIn || record.access === undefined) return yield* fail("needs-sign-in");
    const now = yield* Clock.currentTimeMillis;
    const fresh = record.expiresAt === undefined || record.expiresAt - now > REFRESH_MARGIN_MS;
    // Another request already replaced the rejected token: use the new one, refresh nothing.
    if (rejected === undefined ? fresh : record.access !== rejected) return record.access;
    const client = yield* clientInformationFor(record.client);
    if (record.refresh === undefined || Option.isNone(client)) {
      return yield* markNeedsSignIn(name, record);
    }
    const refreshToken = record.refresh;
    const tokens = yield* outside(
      () =>
        refreshAuthorization(record.authorizationServer, {
          metadata: record.metadata as AuthorizationServerMetadata,
          clientInformation: client.value,
          refreshToken,
          resource: record.resource,
          fetchFn: fetch,
        }),
      "refresh-failed",
    ).pipe(
      Effect.catchIf(
        (error) => error.oauthError === "invalid_grant",
        () => markNeedsSignIn(name, record),
      ),
    );
    const refreshedAt = yield* Clock.currentTimeMillis;
    // The SDK keeps the old refresh token when the server does not rotate it.
    yield* writeRecord(name, {
      ...oauthRecord(record, tokens, refreshedAt),
      ...(record.stepUpScope === undefined ? {} : { stepUpScope: record.stepUpScope }),
    });
    yield* publish;
    return tokens.access_token;
  });

  return IntegrationAuth.of({
    catalog,
    state,
    changes,
    beginConnect,
    completeConnect,
    completeCallback,
    cancelConnect,
    disconnect,
    saveToken,
    saveOwnApp,
    removeOwnApp,
    accessToken: Effect.fn("IntegrationAuth.accessToken")((name: string, rejected?: string) =>
      refreshLock.withPermits(1)(refreshLocked(name, rejected)),
    ),
    update: Effect.fn("IntegrationAuth.update")(function* ({ name, availability }) {
      const server = (yield* getSettings).mcpServers[name];
      const integration = integrationOf(server);
      if (server?.transport !== "http" || integration === undefined) {
        return yield* fail("not-connected");
      }
      yield* storage(
        serverSettings.updateSettings({
          mcpServers: { [name]: { ...server, integration: { ...integration, availability } } },
        }),
        "write-settings",
      );
      return yield* viewByName(name);
    }),
    makeAvailable: detector.makeAvailable,
    // Untraced: the proxy reports after every upstream request.
    reportReachable: Effect.fnUntraced(function* (name: string, reachable: boolean) {
      const changed = reachable ? unreachable.delete(name) : !unreachable.has(name);
      if (!reachable) unreachable.add(name);
      if (changed) yield* publish;
    }),
    markRejected: Effect.fn("IntegrationAuth.markRejected")(function* (name: string) {
      const stored = Option.getOrUndefined(yield* readRecord(name));
      if (stored?.kind !== "oauth") return;
      yield* markNeedsSignIn(name, stored).pipe(Effect.catchIf(isNeedsSignIn, () => Effect.void));
    }),
    markNeedsMoreAccess: Effect.fn("IntegrationAuth.markNeedsMoreAccess")(function* (
      name: string,
      scope: string | undefined,
    ) {
      const stored = Option.getOrUndefined(yield* readRecord(name));
      if (stored?.kind !== "oauth") return;
      yield* writeRecord(name, {
        ...stored,
        stepUpScope: scopeUnion(stored.scope, stored.stepUpScope, scope),
      });
      yield* publish;
    }),
  });
});

const isNeedsSignIn = (error: IntegrationError) => error.reason === "needs-sign-in";

export const layer = Layer.effect(IntegrationAuth, make);
