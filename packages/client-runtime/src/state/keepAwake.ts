import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export function createKeepAwakeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:keep-awake:status",
      subscribe: (_input: null) => subscribe(WS_METHODS.keepAwakeSubscribeStatus, {}),
    }),
  };
}
