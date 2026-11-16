import { type HeavyNotice, WS_METHODS } from "@t3tools/contracts";
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
    notices: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:heavy-queue:notices",
      tag: WS_METHODS.heavyQueueSubscribeNotices,
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
    route: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:route",
      tag: WS_METHODS.heavyQueueRoute,
    }),
    routeAll: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:route-all",
      tag: WS_METHODS.heavyQueueRouteAll,
    }),
    setMaxRunning: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-max-running",
      tag: WS_METHODS.heavyQueueSetMaxRunning,
    }),
    setMacMemoryFloorPercent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-mac-memory-floor-percent",
      tag: WS_METHODS.heavyQueueSetMacMemoryFloorPercent,
    }),
    setMacCpuCeilingPercent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-mac-cpu-ceiling-percent",
      tag: WS_METHODS.heavyQueueSetMacCpuCeilingPercent,
    }),
    setHeavyOverLimitSeconds: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-heavy-over-limit-seconds",
      tag: WS_METHODS.heavyQueueSetHeavyOverLimitSeconds,
    }),
    setAdmissionLimits: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-admission-limits",
      tag: WS_METHODS.heavyQueueSetAdmissionLimits,
    }),
    setPriority: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-priority",
      tag: WS_METHODS.heavyQueueSetPriority,
    }),
    setClaudeHook: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-claude-hook",
      tag: WS_METHODS.heavyQueueSetClaudeHook,
    }),
    setDeviceIdleMinutes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:heavy-queue:set-device-idle-minutes",
      tag: WS_METHODS.heavyQueueSetDeviceIdleMinutes,
    }),
  };
}

/**
 * The notices of a batch not yet shown in this exact form, remembering them. A subscription
 * replays its last batch on remount, and a grouped notice comes back under its id with a new count.
 */
export function unseenHeavyNotices(
  batch: ReadonlyArray<HeavyNotice>,
  shown: Map<string, string>,
): ReadonlyArray<HeavyNotice> {
  return batch.filter((notice) => {
    const key = `${notice.title}\n${notice.description}`;
    if (shown.get(notice.id) === key) return false;
    shown.set(notice.id, key);
    return true;
  });
}
