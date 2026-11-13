import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { HeaderName, McpServerName, McpServerUrl } from "./mcpServers.ts";

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

export const IntegrationView = Schema.Struct({
  name: McpServerName,
  catalogId: Schema.NullOr(McpServerName),
  auth: Schema.Literals(["oauth", "token"]),
  status: IntegrationStatus,
  lastError: Schema.optionalKey(IntegrationErrorReason),
  expiresAt: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  availability: Schema.Literals(["assistants", "all"]),
});
export type IntegrationView = typeof IntegrationView.Type;

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

export const INTEGRATIONS_WS_METHODS = {
  integrationsSubscribe: "integrations.subscribe",
  integrationsBeginConnect: "integrations.beginConnect",
  integrationsCompleteConnect: "integrations.completeConnect",
  integrationsCancelConnect: "integrations.cancelConnect",
  integrationsDisconnect: "integrations.disconnect",
  integrationsSaveToken: "integrations.saveToken",
  integrationsSaveOwnApp: "integrations.saveOwnApp",
  integrationsRemoveOwnApp: "integrations.removeOwnApp",
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
  { payload: Schema.Struct({ flowId: Schema.String }), error: errors },
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
