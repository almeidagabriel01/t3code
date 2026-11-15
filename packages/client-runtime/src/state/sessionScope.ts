import {
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

/** What a session check proves: "unknown" until a session has resolved. */
export type SessionScopeAccess = "unknown" | "granted" | "missing";

/** A failed refresh keeps the last session it had; with none, it proves no scope is missing. */
export function sessionScopeAccess(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): SessionScopeAccess {
  const session = AsyncResult.value(result);
  if (Option.isNone(session)) return "unknown";
  return scopes.every((scope) => sessionGrantsScope(session.value, scope)) ? "granted" : "missing";
}

/** Controls stay locked until the session proves the scope. */
export const scopeAccessLocked = (access: SessionScopeAccess) => access !== "granted";

/** A permission notice shows only once the session proves the scope is missing. */
export const scopeAccessShowsBanner = (access: SessionScopeAccess) => access === "missing";
