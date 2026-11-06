import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createHeavyQueueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:heavy-queue:state",
      tag: WS_METHODS.heavyQueueSubscribe,
    }),
    promote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:promote",
      tag: WS_METHODS.heavyQueuePromote,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:cancel",
      tag: WS_METHODS.heavyQueueCancel,
    }),
  };
}
