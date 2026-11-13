import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { HeaderName, McpServerName, McpServerUrl } from "./mcpServers.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const INTEGRATIONS_CALLBACK_PATH = "/oauth/integrations/callback";
/** Path on the client's loopback listener (desktop) or the address the user pastes back. */
export const INTEGRATIONS_LOOPBACK_CALLBACK_PATH = "/integrations/callback";

/** Where providers reach a connected integration on T3's MCP server: `<prefix>/<name>`. */
export const INTEGRATIONS_PROXY_PATH_PREFIX = "/mcp/integrations";

const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/));
const ClientGroup = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/));
const TokenFormat = Schema.String.check(Schema.isPattern(/\{token\}/));

export const IntegrationCategory = Schema.Literals([
  "calendar",
  "email",
  "chat",
  "docs",
  "tasks",
  "files",
  "dev",
  "design",
  "crm",
  "payments",
  "automation",
]);

export const IntegrationEntryAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("oauth"), registration: Schema.Literal("dynamic") }),
  Schema.Struct({
    kind: Schema.Literal("oauth"),
    registration: Schema.Literal("own-app"),
    clientGroup: ClientGroup,
    setupUrl: Schema.optionalKey(HttpsUrl),
    // Entra supports S256 but does not advertise it; only an own app may rely on that.
    pkce: Schema.optionalKey(Schema.Literal("assume-s256")),
  }),
  Schema.Struct({
    kind: Schema.Literal("token"),
    header: HeaderName,
    format: TokenFormat,
    tokenUrl: Schema.optionalKey(HttpsUrl),
  }),
  Schema.Struct({ kind: Schema.Literal("none") }),
]);
export type IntegrationEntryAuth = typeof IntegrationEntryAuth.Type;

export const IntegrationCatalogEntry = Schema.Struct({
  id: McpServerName,
  name: Schema.String.check(Schema.isMinLength(1)),
  category: IntegrationCategory,
  description: Schema.String,
  icon: Schema.optionalKey(Schema.Struct({ svg: Schema.String, color: Schema.String })),
  docsUrl: HttpsUrl,
  server: Schema.Union([
    Schema.Struct({ transport: Schema.Literal("http"), url: McpServerUrl }),
    Schema.Struct({
      transport: Schema.Literal("stdio"),
      package: Schema.String,
      command: Schema.String,
      args: Schema.Array(Schema.String),
    }),
  ]),
  auth: IntegrationEntryAuth,
  tokenFallback: Schema.optionalKey(
    Schema.Struct({
      header: HeaderName,
      format: TokenFormat,
      tokenUrl: Schema.optionalKey(HttpsUrl),
    }),
  ),
  // Skips server-route callbacks for vendors that allow-list non-loopback redirects.
  redirect: Schema.optionalKey(Schema.Literal("loopback-only")),
  scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  readOnlyTools: Schema.optionalKey(Schema.Array(Schema.String)),
  availability: Schema.optionalKey(Schema.Literals(["preview", "unavailable"])),
  note: Schema.optionalKey(Schema.String),
  match: Schema.Struct({
    urls: Schema.Array(Schema.String),
    packages: Schema.Array(Schema.String),
    names: Schema.Array(Schema.String),
  }),
});
export type IntegrationCatalogEntry = typeof IntegrationCatalogEntry.Type;

export const IntegrationStatus = Schema.Literals([
  "not-connected",
  "connecting",
  "connected",
  "needs-sign-in",
  "needs-more-access",
  "error",
]);
export type IntegrationStatus = typeof IntegrationStatus.Type;

export const IntegrationErrorReason = Schema.Literals([
  "unknown-entry",
  "unsupported-auth",
  "own-app-required",
  "unsafe-address",
  "discovery-failed",
  "pkce-unsupported",
  "registration-unavailable",
  "registration-failed",
  "sign-in-expired",
  "sign-in-denied",
  "invalid-callback",
  "exchange-failed",
  "invalid-token",
  "not-connected",
  "needs-sign-in",
  "refresh-failed",
  "storage-failed",
  // The service did not answer, or answered 502/503/504; clears on its next answer.
  "unreachable",
  // Make available: the detected server changed or went away since the client listed it.
  "detected-not-found",
  // Make available: claude.ai connectors and transports T3 cannot run (sse) stay where they are.
  "not-copyable",
  // Make available: T3 only stores https URLs (http on loopback) without query or userinfo.
  "url-not-allowed",
]);
export type IntegrationErrorReason = typeof IntegrationErrorReason.Type;

export class IntegrationError extends Schema.TaggedError<IntegrationError>()("IntegrationError", {
  reason: IntegrationErrorReason,
  // The authorization server's OAuth error code (RFC 6749 §5.2), when it sent one.
  oauthError: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
}) {
  override get message(): string {
    return `Integration sign-in failed: ${this.reason}.`;
  }
}

export const IntegrationAvailability = Schema.Literals(["assistants", "all"]);

export const IntegrationView = Schema.Struct({
  name: McpServerName,
  catalogId: Schema.NullOr(McpServerName),
  auth: Schema.Literals(["oauth", "token"]),
  status: IntegrationStatus,
  lastError: Schema.optionalKey(IntegrationErrorReason),
  expiresAt: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  availability: IntegrationAvailability,
});
export type IntegrationView = typeof IntegrationView.Type;

/** Where an MCP server set up outside T3's integrations lives. */
export const DetectedOrigin = Schema.Literals(["claude-code", "codex", "claude-ai", "t3"]);
export type DetectedOrigin = typeof DetectedOrigin.Type;

/**
 * An MCP server found by a read-only scan (INT-29). Never carries a value: the URL drops its
 * query, fragment and userinfo, the command its arguments, and headers and env are key names.
 */
export const DetectedServer = Schema.Struct({
  /** Changes when the server's settings change, so a stale copy request finds nothing. */
  id: Schema.String,
  name: Schema.String,
  origin: DetectedOrigin,
  /** The Claude or Codex provider instance whose config holds it. */
  instanceId: Schema.optionalKey(ProviderInstanceId),
  /** Claude Code: "user", "local", "project" (`.mcp.json`) or "plugin". */
  scope: Schema.optionalKey(Schema.String),
  projectPath: Schema.optionalKey(Schema.String),
  catalogId: Schema.NullOr(McpServerName),
  /** "http", "stdio" or "sse" as the source names it. */
  transport: Schema.String,
  url: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  /** Claude: its status in that instance's latest session ("connected", "needs-auth", …). */
  loaded: Schema.optionalKey(Schema.String),
  /** `.mcp.json` servers load only once approved in Claude Code. */
  approval: Schema.optionalKey(Schema.Literals(["approved", "pending", "disabled"])),
  enabled: Schema.Boolean,
  /** "Make available to all providers" applies (INT-36..38). */
  copyable: Schema.Boolean,
  /** Header and env names whose values a copy stores as T3 secrets. */
  secretKeys: Schema.Array(Schema.String),
  /** Names whose value comes from the environment (`${VAR}`, `bearer_token_env_var`); never resolved. */
  needsValue: Schema.Array(Schema.String),
});
export type DetectedServer = typeof DetectedServer.Type;

export const DetectionSource = Schema.Struct({
  origin: DetectedOrigin,
  instanceId: Schema.optionalKey(ProviderInstanceId),
  path: Schema.optionalKey(Schema.String),
  /** "not-seen": no Claude session has reported claude.ai connectors yet (D11). */
  status: Schema.Literals(["ok", "missing", "unreadable", "not-seen"]),
  reason: Schema.optionalKey(
    Schema.Literals(["permission-denied", "invalid-format", "read-failed"]),
  ),
  seenAt: Schema.optionalKey(Schema.Number),
});
export type DetectionSource = typeof DetectionSource.Type;

/**
 * Loaded natively, so T3 neither injects its copy there nor offers Connect for it (D7). Only
 * evidence that holds in every project of the instance counts, and only a working connection.
 */
export const loadedNatively = (server: DetectedServer): boolean =>
  server.catalogId !== null &&
  server.enabled &&
  (server.origin === "codex" ||
    ((server.origin === "claude-ai" ||
      (server.origin === "claude-code" &&
        (server.scope === "user" || server.scope === "plugin"))) &&
      server.loaded === "connected"));

// Drivers whose adapter reads `McpProviderSessions.connectors`: Claude, Codex, Cursor, and the
// ACP adapter (Grok, Kiro and FX through the stdio bridge). Muse, Pi, OpenCode and cloud agents do not.
const INTEGRATION_DRIVERS = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "antigravity",
  "acpRegistry",
  "grok",
  "kiro",
  "fx",
]);

/** Whether T3's integrations reach a provider of this driver. */
export const integrationProviderSupport = (driverKind: string): boolean =>
  INTEGRATION_DRIVERS.has(driverKind);

export const IntegrationOwnAppView = Schema.Struct({
  clientGroup: ClientGroup,
  clientId: Schema.String,
  hasClientSecret: Schema.Boolean,
});

export const IntegrationsState = Schema.Struct({
  catalog: Schema.Array(IntegrationCatalogEntry),
  integrations: Schema.Array(IntegrationView),
  ownApps: Schema.Array(IntegrationOwnAppView),
  /** This environment's stable loopback redirect URI (D15), for own-app setup. */
  loopbackRedirectUri: Schema.String,
  detected: Schema.Array(DetectedServer),
  detectionSources: Schema.Array(DetectionSource),
});
export type IntegrationsState = typeof IntegrationsState.Type;

export const IntegrationAppScheme = Schema.Literals(["t3code", "t3code-preview", "t3code-dev"]);

export const IntegrationBeginConnectInput = Schema.Struct({
  catalogId: McpServerName,
  client: Schema.Struct({
    kind: Schema.Literals(["web", "desktop", "mobile"]),
    /** The origin this client reaches the server through (the page origin for same-origin web). */
    origin: Schema.optionalKey(Schema.String),
    /** The client can listen on the loopback redirect URI (desktop). */
    loopback: Schema.optionalKey(Schema.Boolean),
    /** The client found the loopback port busy; the server moves to a new one. */
    loopbackBusy: Schema.optionalKey(Schema.Boolean),
    returnScheme: Schema.optionalKey(IntegrationAppScheme),
  }),
});
export type IntegrationBeginConnectInput = typeof IntegrationBeginConnectInput.Type;

export const IntegrationConnectMode = Schema.Literals(["server", "loopback", "paste"]);
export type IntegrationConnectMode = typeof IntegrationConnectMode.Type;

export const IntegrationBeginConnectResult = Schema.Struct({
  flowId: Schema.String,
  name: McpServerName,
  authorizationUrl: Schema.String,
  mode: IntegrationConnectMode,
  redirectUri: Schema.String,
  expiresAt: Schema.Number,
});
export type IntegrationBeginConnectResult = typeof IntegrationBeginConnectResult.Type;

export const IntegrationCompleteConnectInput = Schema.Struct({
  flowId: Schema.optionalKey(Schema.String),
  callbackUrl: Schema.String.check(Schema.isMaxLength(8192)),
});

export const IntegrationSaveTokenInput = Schema.Struct({
  catalogId: McpServerName,
  token: Schema.String.check(Schema.isMaxLength(8192)),
});

export const IntegrationSaveOwnAppInput = Schema.Struct({
  clientGroup: ClientGroup,
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  /** Absent keeps the saved secret; an empty string removes it. */
  clientSecret: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
});
export type IntegrationSaveOwnAppInput = typeof IntegrationSaveOwnAppInput.Type;

export const IntegrationUpdateInput = Schema.Struct({
  name: McpServerName,
  availability: IntegrationAvailability,
});
export type IntegrationUpdateInput = typeof IntegrationUpdateInput.Type;

export const IntegrationMakeAvailableResult = Schema.Union([
  /** Copied into T3's MCP servers; `leftOut` names need a value the source did not hold. */
  Schema.Struct({
    outcome: Schema.Literal("copied"),
    name: McpServerName,
    leftOut: Schema.Array(Schema.String),
  }),
  /** The source signs in with OAuth T3 cannot reuse: Connect the catalog entry instead (INT-37). */
  Schema.Struct({ outcome: Schema.Literal("connect"), catalogId: McpServerName }),
]);
export type IntegrationMakeAvailableResult = typeof IntegrationMakeAvailableResult.Type;

export const INTEGRATIONS_WS_METHODS = {
  integrationsSubscribe: "integrations.subscribe",
  integrationsBeginConnect: "integrations.beginConnect",
  integrationsCompleteConnect: "integrations.completeConnect",
  integrationsCancelConnect: "integrations.cancelConnect",
  integrationsDisconnect: "integrations.disconnect",
  integrationsSaveToken: "integrations.saveToken",
  integrationsSaveOwnApp: "integrations.saveOwnApp",
  integrationsRemoveOwnApp: "integrations.removeOwnApp",
  integrationsUpdate: "integrations.update",
  integrationsMakeAvailable: "integrations.makeAvailable",
} as const;

const errors = Schema.Union([IntegrationError, EnvironmentAuthorizationError]);

export const WsIntegrationsSubscribeRpc = Rpc.make(INTEGRATIONS_WS_METHODS.integrationsSubscribe, {
  payload: Schema.Struct({}),
  success: IntegrationsState,
  error: errors,
  stream: true,
});
export const WsIntegrationsBeginConnectRpc = Rpc.make(
  INTEGRATIONS_WS_METHODS.integrationsBeginConnect,
  { payload: IntegrationBeginConnectInput, success: IntegrationBeginConnectResult, error: errors },
);
export const WsIntegrationsCompleteConnectRpc = Rpc.make(
  INTEGRATIONS_WS_METHODS.integrationsCompleteConnect,
  { payload: IntegrationCompleteConnectInput, success: IntegrationView, error: errors },
);
export const WsIntegrationsCancelConnectRpc = Rpc.make(
  INTEGRATIONS_WS_METHODS.integrationsCancelConnect,
  { payload: Schema.Struct({ name: McpServerName }), error: errors },
);
export const WsIntegrationsDisconnectRpc = Rpc.make(
  INTEGRATIONS_WS_METHODS.integrationsDisconnect,
  {
    payload: Schema.Struct({ name: McpServerName }),
    error: errors,
  },
);
export const WsIntegrationsSaveTokenRpc = Rpc.make(INTEGRATIONS_WS_METHODS.integrationsSaveToken, {
  payload: IntegrationSaveTokenInput,
  success: IntegrationView,
  error: errors,
});
export const WsIntegrationsSaveOwnAppRpc = Rpc.make(
  INTEGRATIONS_WS_METHODS.integrationsSaveOwnApp,
  {
    payload: IntegrationSaveOwnAppInput,
    error: errors,
  },
);
export const WsIntegrationsRemoveOwnAppRpc = Rpc.make(
  INTEGRATIONS_WS_METHODS.integrationsRemoveOwnApp,
  { payload: Schema.Struct({ clientGroup: ClientGroup }), error: errors },
);
export const WsIntegrationsUpdateRpc = Rpc.make(INTEGRATIONS_WS_METHODS.integrationsUpdate, {
  payload: IntegrationUpdateInput,
  success: IntegrationView,
  error: errors,
});
export const WsIntegrationsMakeAvailableRpc = Rpc.make(
  INTEGRATIONS_WS_METHODS.integrationsMakeAvailable,
  {
    payload: Schema.Struct({ detectedId: Schema.String.check(Schema.isMaxLength(128)) }),
    success: IntegrationMakeAvailableResult,
    error: errors,
  },
);
