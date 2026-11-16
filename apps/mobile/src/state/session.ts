import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import {
  sessionScopeAccess,
  type SessionScopeAccess,
} from "@t3tools/client-runtime/state/sessionScope";
import {
  type AuthEnvironmentScope,
  type AuthSessionState,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

export function sessionHasScope(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  return sessionScopeAccess(result, [scope]) === "granted";
}

/** For permission notices: "unknown" until the session resolves, so nothing flashes meanwhile. */
export function useEnvironmentScopeAccess(
  environmentId: EnvironmentId | null,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): SessionScopeAccess {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
    (result) => sessionScopeAccess(result, scopes),
  );
}

export function useEnvironmentScope(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): boolean {
  // Select the grant: every revalidation emits a new result, and most consumers are list rows.
  return useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
    (result) => sessionHasScope(result, scope),
  );
}

export function useEnvironmentsWithScope(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  scope: AuthEnvironmentScope,
): ReadonlySet<EnvironmentId> {
  const permittedEnvironments = useMemo(
    () =>
      Atom.make((get) => {
        const permitted = new Set<EnvironmentId>();
        for (const { environmentId } of environments) {
          if (sessionHasScope(get(environmentSession.sessionStateAtom(environmentId)), scope)) {
            permitted.add(environmentId);
          }
        }
        return permitted;
      }),
    [environments, scope],
  );
  return useAtomValue(permittedEnvironments);
}

/** Per environment, for permission notices: "unknown" until its session resolves. */
export function useEnvironmentsScopeAccess(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  scope: AuthEnvironmentScope,
): ReadonlyMap<EnvironmentId, SessionScopeAccess> {
  const accessAtom = useMemo(
    () =>
      Atom.make(
        (get) =>
          new Map(
            environments.map(({ environmentId }) => [
              environmentId,
              sessionScopeAccess(get(environmentSession.sessionStateAtom(environmentId)), [scope]),
            ]),
          ),
      ),
    [environments, scope],
  );
  return useAtomValue(accessAtom);
}

export function readEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  const result = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return sessionHasScope(result, scope);
}

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("mobile-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}
