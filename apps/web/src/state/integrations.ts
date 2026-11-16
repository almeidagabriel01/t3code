import { useAtomValue } from "@effect/atom-react";
import { createIntegrationsEnvironmentAtoms } from "@t3tools/client-runtime/state/integrations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IntegrationBeginConnectInput,
  IntegrationSaveOwnAppInput,
  IntegrationsState,
  IntegrationUpdateInput,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";

const integrationsEnvironment = createIntegrationsEnvironmentAtoms(connectionAtomRuntime);

const integrationsEnvironmentIdsAtom = Atom.make((get) => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.integrations === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("web-integrations-environment-ids"));

/** Connected environments whose server has integrations. */
export function useIntegrationsEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(integrationsEnvironmentIdsAtom);
}

const integrationsStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): IntegrationsState | null =>
    Option.getOrNull(
      AsyncResult.value(get(integrationsEnvironment.live({ environmentId, input: null }))),
    ),
  ).pipe(Atom.withLabel(`web-integrations-state:${environmentId}`)),
);
const NO_INTEGRATIONS = Atom.make<IntegrationsState | null>(null).pipe(
  Atom.withLabel("web-integrations-state-none"),
);

/** The environment's integrations, live; null without the capability or before the first push. */
export function useIntegrationsState(
  environmentId: EnvironmentId | null,
): IntegrationsState | null {
  const supported = useIntegrationsEnvironmentIds();
  return useAtomValue(
    environmentId !== null && supported.includes(environmentId)
      ? integrationsStateAtom(environmentId)
      : NO_INTEGRATIONS,
  );
}

const openIntegrationsStatesAtom = Atom.make((get) =>
  get(integrationsEnvironmentIdsAtom).flatMap((environmentId) => {
    const state = get(integrationsStateAtom(environmentId));
    return state === null ? [] : [state];
  }),
).pipe(Atom.withLabel("web-integrations-open-states"));

/** Every connected environment's integrations, live, so Settings search finds them by name. */
export function useOpenIntegrationsStates(): ReadonlyArray<IntegrationsState> {
  return useAtomValue(openIntegrationsStatesAtom);
}

/** `reason` is the server's `IntegrationError` reason, for `integrationErrorMessage`. */
export type IntegrationReply<A = void> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

const reply = <A>(
  result:
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
): IntegrationReply<A> => {
  if (result._tag === "Success") return { ok: true, value: result.value };
  const error = squashAtomCommandFailure(result);
  return {
    ok: false,
    reason:
      typeof error === "object" && error !== null && "reason" in error
        ? String(error.reason)
        : "unknown",
  };
};

/** Each change settles into a reply; the new state itself arrives through the subscription. */
export function useIntegrationActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(integrationsEnvironment.beginConnect.permissionAtom(environmentId));
  const options = { reportFailure: false } as const;
  const begin = useAtomCommand(integrationsEnvironment.beginConnect, options);
  const complete = useAtomCommand(integrationsEnvironment.completeConnect, options);
  const cancel = useAtomCommand(integrationsEnvironment.cancelConnect, options);
  const disconnect = useAtomCommand(integrationsEnvironment.disconnect, options);
  const saveToken = useAtomCommand(integrationsEnvironment.saveToken, options);
  const saveOwnApp = useAtomCommand(integrationsEnvironment.saveOwnApp, options);
  const removeOwnApp = useAtomCommand(integrationsEnvironment.removeOwnApp, options);
  const update = useAtomCommand(integrationsEnvironment.update, options);
  const makeAvailable = useAtomCommand(integrationsEnvironment.makeAvailable, options);
  return {
    canAct,
    beginConnect: async (input: IntegrationBeginConnectInput) =>
      reply(await begin({ environmentId, input })),
    completeConnect: async (input: { readonly flowId: string; readonly callbackUrl: string }) =>
      reply(await complete({ environmentId, input })),
    /** Ends the pending sign-in of integration `name`, wherever it started. */
    cancelConnect: async (name: string) => reply(await cancel({ environmentId, input: { name } })),
    disconnect: async (name: string) => reply(await disconnect({ environmentId, input: { name } })),
    saveToken: async (catalogId: string, token: string) =>
      reply(await saveToken({ environmentId, input: { catalogId, token } })),
    saveOwnApp: async (input: IntegrationSaveOwnAppInput) =>
      reply(await saveOwnApp({ environmentId, input })),
    removeOwnApp: async (clientGroup: string) =>
      reply(await removeOwnApp({ environmentId, input: { clientGroup } })),
    update: async (input: IntegrationUpdateInput) => reply(await update({ environmentId, input })),
    makeAvailable: async (detectedId: string) =>
      reply(await makeAvailable({ environmentId, input: { detectedId } })),
  };
}

export type IntegrationActions = ReturnType<typeof useIntegrationActions>;
