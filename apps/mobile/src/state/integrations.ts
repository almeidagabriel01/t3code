import { useAtomValue } from "@effect/atom-react";
import { createIntegrationsEnvironmentAtoms } from "@t3tools/client-runtime/state/integrations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type IntegrationBeginConnectInput,
  type IntegrationSaveOwnAppInput,
  type IntegrationsState,
  type IntegrationUpdateInput,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession, sessionHasScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

const integrationsEnvironment = createIntegrationsEnvironmentAtoms(connectionAtomRuntime);

/** Environments whose server has integrations, from the cached server config. Opens no stream. */
const integrationsEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.integrations === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-integrations-environment-ids"));

const integrationsFeedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): IntegrationsState | null =>
    sessionHasScope(
      get(environmentSession.sessionStateAtom(environmentId)),
      AuthOrchestrationReadScope,
    )
      ? Option.getOrNull(
          AsyncResult.value(get(integrationsEnvironment.live({ environmentId, input: null }))),
        )
      : null,
  ).pipe(Atom.withLabel(`mobile-integrations-feed:${environmentId}`)),
);

const NO_STATE_ATOM = Atom.make<IntegrationsState | null>(null);

/** Environments whose server has integrations. */
export function useIntegrationsEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(integrationsEnvironmentIdsAtom);
}

/** The live integrations of an environment; null before its first state or without the feature. */
export function useIntegrationsState(
  environmentId: EnvironmentId | null,
): IntegrationsState | null {
  const ids = useAtomValue(integrationsEnvironmentIdsAtom);
  return useAtomValue(
    environmentId !== null && ids.includes(environmentId)
      ? integrationsFeedAtom(environmentId)
      : NO_STATE_ATOM,
  );
}

/** `reason` feeds `integrationErrorMessage`; anything that is not an integration refusal reads as Error. */
export type IntegrationReply<A = void> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: string };

export const integrationReply = <A>(
  result:
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
): IntegrationReply<A> => {
  if (result._tag === "Success") return { ok: true, value: result.value };
  const error = squashAtomCommandFailure(result);
  const reason =
    typeof error === "object" && error !== null && "reason" in error ? String(error.reason) : "";
  return { ok: false, reason };
};

/** Each change settles into a reply; the new state itself arrives through the live feed. */
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
      integrationReply(await begin({ environmentId, input })),
    completeConnect: async (input: { readonly flowId: string; readonly callbackUrl: string }) =>
      integrationReply(await complete({ environmentId, input })),
    cancelConnect: async (name: string) =>
      integrationReply(await cancel({ environmentId, input: { name } })),
    disconnect: async (name: string) =>
      integrationReply(await disconnect({ environmentId, input: { name } })),
    saveToken: async (catalogId: string, token: string) =>
      integrationReply(await saveToken({ environmentId, input: { catalogId, token } })),
    saveOwnApp: async (input: IntegrationSaveOwnAppInput) =>
      integrationReply(await saveOwnApp({ environmentId, input })),
    removeOwnApp: async (clientGroup: string) =>
      integrationReply(await removeOwnApp({ environmentId, input: { clientGroup } })),
    update: async (input: IntegrationUpdateInput) =>
      integrationReply(await update({ environmentId, input })),
    makeAvailable: async (detectedId: string) =>
      integrationReply(await makeAvailable({ environmentId, input: { detectedId } })),
  };
}

export type IntegrationActions = ReturnType<typeof useIntegrationActions>;
