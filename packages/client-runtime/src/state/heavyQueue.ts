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
    commands: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:heavy-queue:commands",
      tag: WS_METHODS.heavyQueueSubscribeCommands,
    }),
    stopCommand: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:stop-command",
      tag: WS_METHODS.heavyQueueStopCommand,
    }),
    promote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:promote",
      tag: WS_METHODS.heavyQueuePromote,
    }),
    startNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:start-now",
      tag: WS_METHODS.heavyQueueStartNow,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:cancel",
      tag: WS_METHODS.heavyQueueCancel,
    }),
    move: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:move",
      tag: WS_METHODS.heavyQueueMove,
    }),
    setPaused: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-paused",
      tag: WS_METHODS.heavyQueueSetPaused,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-enabled",
      tag: WS_METHODS.heavyQueueSetEnabled,
    }),
    setRule: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-rule",
      tag: WS_METHODS.heavyQueueSetRule,
    }),
    setMaxRunning: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-max-running",
      tag: WS_METHODS.heavyQueueSetMaxRunning,
    }),
  };
}
