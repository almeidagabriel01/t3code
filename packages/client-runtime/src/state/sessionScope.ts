import {
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

/**
 * What a session check proves. "unknown" waits for the first answer; "unavailable" is a check that
 * failed with no session to fall back on, so it proves neither a grant nor a missing scope.
 */
export type SessionScopeAccess = "unknown" | "unavailable" | "granted" | "missing";

/** A failed refresh keeps the last session it had; with none, the check is unavailable. */
export function sessionScopeAccess(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): SessionScopeAccess {
  const session = AsyncResult.value(result);
  if (Option.isNone(session)) return result._tag === "Failure" ? "unavailable" : "unknown";
  return scopes.every((scope) => sessionGrantsScope(session.value, scope)) ? "granted" : "missing";
}

/** Controls stay locked until the session proves the scope. */
export const scopeAccessLocked = (access: SessionScopeAccess) => access !== "granted";

/** A permission notice shows only once the session proves the scope is missing. */
export const scopeAccessShowsBanner = (access: SessionScopeAccess) => access === "missing";

export const SCOPE_ACCESS_CHECKING_MESSAGE = "Checking access…";
export const SCOPE_ACCESS_UNAVAILABLE_MESSAGE = "Couldn't check this connection's access.";

/** The text for an access state: none when granted, the caller's permission text when missing. */
export function scopeAccessMessage(access: SessionScopeAccess, missing: string): string | null {
  switch (access) {
    case "granted":
      return null;
    case "missing":
      return missing;
    case "unknown":
      return SCOPE_ACCESS_CHECKING_MESSAGE;
    case "unavailable":
      return SCOPE_ACCESS_UNAVAILABLE_MESSAGE;
  }
}
