import {
  WS_METHODS,
  type ImessageChannelSettings,
  type ImessageChannelStatusEvent,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** Lays a live status event over the stored settings; the event replaces status and errors. */
export function applyImessageStatusEvent(
  settings: ImessageChannelSettings,
  event: ImessageChannelStatusEvent,
): ImessageChannelSettings {
  const { lastError: _lastError, lastDeliveryError: _lastDeliveryError, ...rest } = settings;
  return {
    ...rest,
    status: event.status,
    ...(event.lastError === undefined ? {} : { lastError: event.lastError }),
    ...(event.lastDeliveryError === undefined
      ? {}
      : { lastDeliveryError: event.lastDeliveryError }),
  };
}

export function createImessageChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One lane per environment keeps handle edits applied in the order they were made.
  const scheduler = createAtomCommandScheduler();
  return {
    settings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:imessage-channel:settings",
      tag: WS_METHODS.imessageChannelGetSettings,
      staleTimeMs: 30_000,
    }),
    status: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:imessage-channel:status",
      subscribe: (_input: null) => subscribe(WS_METHODS.imessageChannelSubscribeStatus, {}),
    }),
    /** The permission state before enabling; read again after the user grants access. */
    access: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:imessage-channel:access",
      tag: WS_METHODS.imessageChannelCheckAccess,
      staleTimeMs: 0,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:imessage-channel:configure",
      tag: WS_METHODS.imessageChannelConfigure,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }: { environmentId: string }) => environmentId,
      },
    }),
  };
}
