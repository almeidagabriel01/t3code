import {
  clientRpcRequiredScopes,
  sessionGrantsScope,
  authScopeRequiredResponse,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type AuthSessionState,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";
import { sessionScopeAccess, type SessionScopeAccess } from "./sessionScope.ts";

function makeCommandPermissions<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  method: string,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  const requiredScopes = (input?: unknown) => clientRpcRequiredScopes(method, input);
  const accessByEnvironment = Atom.family((environmentId: EnvironmentId | null) =>
    Atom.family((scopeKey: string) =>
      Atom.make((get): SessionScopeAccess => {
        if (environmentId === null) return "unknown";
        const scopes = scopeKey.split(",").filter(Boolean) as AuthEnvironmentScope[];
        if (scopes.length === 0) return "granted";
        return sessionScopeAccess(get(sessions.sessionStateAtom(environmentId)), scopes);
      }),
    ),
  );
  const permissionsByEnvironment = Atom.family((environmentId: EnvironmentId | null) =>
    Atom.family((scopeKey: string) =>
      Atom.make((get) => get(accessByEnvironment(environmentId)(scopeKey)) === "granted"),
    ),
  );
  /** For permission notices: "unknown" until the session resolves, so they never flash. */
  const accessAtom = (environmentId: EnvironmentId | null, input?: unknown) =>
    accessByEnvironment(environmentId)(requiredScopes(input).join(","));
  const permissionAtom = (environmentId: EnvironmentId | null, input?: unknown) =>
    permissionsByEnvironment(environmentId)(requiredScopes(input).join(","));
  const authorize = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    input?: unknown,
  ) =>
    Effect.suspend(() => {
      const scopes = requiredScopes(input);
      if (scopes.length === 0) return Effect.void;
      const atom = sessions.sessionStateAtom(environmentId);
      return Effect.scoped(
        Effect.gen(function* () {
          yield* AtomRegistry.mount(registry, atom);
          const session = yield* AtomRegistry.getResult(registry, atom, {
            suspendOnWaiting: false,
          }).pipe(
            Effect.timeoutOption(6_000),
            Effect.orElseSucceed(() => Option.none<AuthSessionState>()),
          );
          const missing = scopes.find(
            (scope) => Option.isNone(session) || !sessionGrantsScope(session.value, scope),
          );
          if (missing !== undefined)
            return yield* new EnvironmentAuthorizationError({
              ...authScopeRequiredResponse(missing),
              message: `This connection requires ${missing}.`,
            });
        }),
      );
    });
  return { requiredScopes, accessAtom, permissionAtom, authorize };
}

const permissionsByRuntime = new WeakMap<
  object,
  Map<string, ReturnType<typeof makeCommandPermissions>>
>();

export function createCommandPermissions<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  method: string,
) {
  let permissions = permissionsByRuntime.get(runtime);
  if (permissions === undefined) {
    permissions = new Map();
    permissionsByRuntime.set(runtime, permissions);
  }
  const existing = permissions.get(method);
  if (existing !== undefined) return existing;
  const created = makeCommandPermissions(runtime, method);
  permissions.set(method, created);
  return created;
}
