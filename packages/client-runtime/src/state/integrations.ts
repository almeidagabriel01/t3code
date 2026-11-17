import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** The live integrations state of an environment and one command per change it accepts. */
export function createIntegrationsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One lane per environment keeps changes applied in the order they were made.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial",
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  } as const;
  const command = <
    TTag extends
      | typeof WS_METHODS.integrationsBeginConnect
      | typeof WS_METHODS.integrationsCompleteConnect
      | typeof WS_METHODS.integrationsCancelConnect
      | typeof WS_METHODS.integrationsDisconnect
      | typeof WS_METHODS.integrationsSaveToken
      | typeof WS_METHODS.integrationsSaveOwnApp
      | typeof WS_METHODS.integrationsRemoveOwnApp
      | typeof WS_METHODS.integrationsUpdate
      | typeof WS_METHODS.integrationsMakeAvailable,
  >(
    tag: TTag,
    name: string,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:integrations:${name}`,
      tag,
      scheduler,
      concurrency,
    });
  return {
    live: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:integrations:live",
      subscribe: (_input: null) => subscribe(WS_METHODS.integrationsSubscribe, {}),
    }),
    beginConnect: command(WS_METHODS.integrationsBeginConnect, "beginConnect"),
    completeConnect: command(WS_METHODS.integrationsCompleteConnect, "completeConnect"),
    cancelConnect: command(WS_METHODS.integrationsCancelConnect, "cancelConnect"),
    disconnect: command(WS_METHODS.integrationsDisconnect, "disconnect"),
    saveToken: command(WS_METHODS.integrationsSaveToken, "saveToken"),
    saveOwnApp: command(WS_METHODS.integrationsSaveOwnApp, "saveOwnApp"),
    removeOwnApp: command(WS_METHODS.integrationsRemoveOwnApp, "removeOwnApp"),
    update: command(WS_METHODS.integrationsUpdate, "update"),
    makeAvailable: command(WS_METHODS.integrationsMakeAvailable, "makeAvailable"),
  };
}
