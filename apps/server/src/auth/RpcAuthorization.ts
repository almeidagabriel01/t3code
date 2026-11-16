import {
  authScopeRequiredResponse,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  RpcScopeAuthorization,
  rpcRequiredScopes,
  WsRpcGroup,
  WsMemoryAdministrationRpcGroup,
  WsMemoryCoreRpcGroup,
  WsMemoryImportRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { captureMemoryGrantCeiling } from "../memory/MemoryAccess.ts";

/** Every RPC the server serves: the base group plus the memory groups, which install separately. */
export const AuthorizedWsRpcGroup = WsRpcGroup.merge(WsMemoryCoreRpcGroup)
  .merge(WsMemoryAdministrationRpcGroup)
  .merge(WsMemoryImportRpcGroup);

const rpcAuthorizationError = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    ...authScopeRequiredResponse(requiredScope),
  });

/**
 * `onAuthorized` runs once after an authorized request succeeds; for a stream
 * RPC, that is when the stream completes. Every RPC passes through here, so it
 * is the one place to observe requests without wrapping each handler.
 */
export const layer = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  onAuthorized?: (method: string, payload: unknown) => Effect.Effect<void>,
) =>
  Layer.succeed(RpcScopeAuthorization)((effect, { rpc, payload }) => {
    const requiredScopes = rpcRequiredScopes(rpc._tag, payload);
    const requiredScope = requiredScopes.find((scope) => !scopes.includes(scope));
    if (requiredScope !== undefined) return Effect.fail(rpcAuthorizationError(requiredScope));
    return onAuthorized === undefined
      ? effect
      : Effect.tap(effect, () => onAuthorized(rpc._tag, payload));
  });

/** Server-only task input port; capture live session grants before persistence, outside SQL. */
export const captureRpcMemoryGrantCeiling = Effect.fn("RpcAuthorization.captureMemoryGrantCeiling")(
  function* <E, R>(input: {
    readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope> | undefined;
    readonly reauthorize?:
      | ((scopes: ReadonlyArray<AuthEnvironmentScope>) => Effect.Effect<void, E, R>)
      | undefined;
    readonly readOnly: boolean;
  }) {
    if (input.grantedScopes === undefined || input.reauthorize === undefined)
      return "none" as const;
    const ceiling = captureMemoryGrantCeiling(input.grantedScopes, input.readOnly);
    const scopes: ReadonlyArray<AuthEnvironmentScope> =
      ceiling === "none"
        ? []
        : ceiling === "read"
          ? ["memory:read"]
          : ["memory:read", "memory:write"];
    yield* input.reauthorize(scopes);
    return ceiling;
  },
);

/** Public task metadata cannot increase a server-captured ceiling. */
export const rejectPublicMemoryGrantCeiling = (input: unknown) =>
  typeof input === "object" &&
  input !== null &&
  "memoryGrantCeiling" in input &&
  input.memoryGrantCeiling !== undefined &&
  input.memoryGrantCeiling !== "none"
    ? Effect.fail(
        new EnvironmentAuthorizationError({
          message: "Task memory ceilings are captured by the server, not supplied by clients.",
          requiredScope: "memory:read",
        }),
      )
    : Effect.void;
