import {
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  type MemoryTaskGrantCeiling,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

export interface McpMemoryPolicy {
  readonly grant: MemoryTaskGrantCeiling;
  readonly policyEpoch: number;
}

export interface McpCredentialRequest {
  /** Memory authority travels as scopes the credential holds; absent means no memory tool access. */
  readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly memoryPolicy?: McpMemoryPolicy;
  /** Reads only committed authority; never SQL or a settings lock. */
  readonly readCurrentPolicy?: () => Effect.Effect<McpMemoryPolicy | undefined>;
  /** False once the owning run no longer holds the provider session. */
  readonly isLiveCaller?: Effect.Effect<boolean>;
  readonly readOnly?: boolean;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** False omits the preview capability wherever the token is honored. Defaults to full access. */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly subagent?: boolean;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  /** SQL-free snapshot policy for an issued credential; stale handles deny. */
  readonly currentMemoryPolicy?: (
    providerSessionId: string,
  ) => Effect.Effect<McpMemoryPolicy | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAliveAt: number;
  readonly memoryPolicy: McpMemoryPolicy | undefined;
  readonly readCurrentPolicy: (() => Effect.Effect<McpMemoryPolicy | undefined>) | undefined;
  readonly isLiveCaller: Effect.Effect<boolean> | undefined;
}

/** Memory authority follows the committed policy; the rest of the credential does not. */
const withoutMemoryAuthority = (
  scope: McpInvocationContext.McpThreadInvocationScope,
): McpInvocationContext.McpThreadInvocationScope => ({
  ...scope,
  ...(scope.grantedScopes === undefined
    ? {}
    : {
        grantedScopes: scope.grantedScopes.filter(
          (granted) => granted !== "memory:read" && granted !== "memory:write",
        ),
      }),
  ...(scope.memoryPolicy === undefined
    ? {}
    : { memoryPolicy: { grant: "none" as const, policyEpoch: scope.memoryPolicy.policyEpoch } }),
  capabilities: new Set(Array.from(scope.capabilities).filter((c) => c !== "memory")),
});

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const browserToolsAvailable = request.browserToolsAvailable ?? true;
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        ...(request.grantedScopes === undefined
          ? {}
          : { grantedScopes: [...request.grantedScopes] }),
        ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
        ...(request.memoryPolicy === undefined ? {} : { memoryPolicy: request.memoryPolicy }),
        reauthorize: Effect.fn("McpSessionRegistry.reauthorize")(function* (
          required: ReadonlyArray<AuthEnvironmentScope>,
        ) {
          const live = yield* SynchronizedRef.get(state).pipe(
            Effect.map(({ records }) => records.get(tokenHash)),
          );
          const missingScope = required.find(
            (scope) => !live?.scope.grantedScopes?.includes(scope),
          );
          const needsMemory = required.some(
            (scope) => scope === "memory:read" || scope === "memory:write",
          );
          const readPolicy = live?.readCurrentPolicy;
          const current = needsMemory && readPolicy ? yield* readPolicy() : undefined;
          const denied =
            live === undefined ||
            missingScope !== undefined ||
            (needsMemory &&
              (live.memoryPolicy === undefined ||
                current === undefined ||
                current.policyEpoch !== live.memoryPolicy.policyEpoch ||
                current.grant !== live.memoryPolicy.grant ||
                current.grant === "none" ||
                (required.includes("memory:write") && current.grant !== "read_write"))) ||
            (live.isLiveCaller !== undefined && !(yield* live.isLiveCaller)) ||
            (request.readOnly === true && required.includes("memory:write"));
          if (denied)
            return yield* new EnvironmentAuthorizationError({
              message:
                live !== undefined && missingScope !== undefined
                  ? `The calling thread's MCP credential is missing required scope: ${missingScope}.`
                  : "The calling thread's MCP credential is no longer active or its authority changed.",
              requiredScope: missingScope ?? required[0] ?? "memory:read",
            });
        }),
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          subagent: request.subagent === true,
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "orchestration",
          "worktree",
          "pull-requests",
          ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
          ...(request.memoryPolicy !== undefined && request.memoryPolicy.grant !== "none"
            ? (["memory"] as const)
            : []),
        ]),
        issuedAt,
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        next.set(tokenHash, {
          tokenHash,
          scope,
          lastAliveAt: issuedAt,
          memoryPolicy: request.memoryPolicy,
          readCurrentPolicy: request.readCurrentPolicy,
          isLiveCaller: request.isLiveCaller,
        });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      const record = yield* SynchronizedRef.modify(state, ({ records }) => {
        const record = records.get(tokenHash);
        if (!record || timestamp - record.lastAliveAt > livenessWindowMs) {
          return [undefined, { records }] as const;
        }
        const next = new Map(records);
        next.set(tokenHash, { ...record, lastAliveAt: timestamp });
        return [record, { records: next }] as const;
      });
      if (record === undefined) return undefined;
      return yield* currentScope(record);
    },
  );

  // A credential issued under an older memory policy keeps its thread authority and loses memory.
  const currentScope = Effect.fn("McpSessionRegistry.currentScope")(function* (
    record: CredentialRecord,
  ) {
    if (!record.readCurrentPolicy || !record.memoryPolicy) return record.scope;
    const current = yield* record.readCurrentPolicy();
    return current === undefined ||
      current.policyEpoch !== record.memoryPolicy.policyEpoch ||
      current.grant !== record.memoryPolicy.grant
      ? withoutMemoryAuthority(record.scope)
      : record.scope;
  });

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        for (const [tokenHash, record] of records) {
          if (record.scope.thread.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next };
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return McpSessionRegistry.of({
    issue,
    resolve,
    currentMemoryPolicy: Effect.fn("McpSessionRegistry.currentMemoryPolicy")(
      function* (providerSessionId) {
        const { records } = yield* SynchronizedRef.get(state);
        const record = Array.from(records.values()).find(
          (candidate) => candidate.scope.thread.providerSessionId === providerSessionId,
        );
        if (!record?.readCurrentPolicy || !record.memoryPolicy) return undefined;
        if (record.isLiveCaller && !(yield* record.isLiveCaller)) return undefined;
        const current = yield* record.readCurrentPolicy();
        return current?.policyEpoch === record.memoryPolicy.policyEpoch &&
          current.grant === record.memoryPolicy.grant
          ? current
          : undefined;
      },
    ),
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread.threadId === threadId);
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
