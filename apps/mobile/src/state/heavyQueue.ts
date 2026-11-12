import { useAtomValue } from "@effect/atom-react";
import { createHeavyQueueEnvironmentAtoms } from "@t3tools/client-runtime/state/heavyQueue";
import type { EnvironmentId, HeavyCommandsState, HeavyQueueState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const heavyQueueEnvironment = createHeavyQueueEnvironmentAtoms(connectionAtomRuntime);

const EMPTY: HeavyQueueState = {
  entries: [],
  enabled: true,
  paused: false,
  rules: [],
  maxRunning: 1,
  reasons: {},
  room: true,
  claudeHookInstalled: false,
  deviceIdleMinutes: 20,
  machine: null,
  linux: null,
  macOnly: [],
  routes: {},
};

/** Run order, running entries first; empty while loading or when an older server rejects it. */
export function useHeavyQueueState(environmentId: EnvironmentId): HeavyQueueState {
  const state = useAtomValue(heavyQueueEnvironment.state({ environmentId, input: {} }));
  return Option.getOrElse(AsyncResult.value(state), () => EMPTY);
}

const NO_COMMANDS: HeavyCommandsState = { commands: [], cpuCount: 1 };

/** Live only while mounted: subscribing keeps the server sampling processes. Empty on older servers. */
export function useHeavyCommandsState(environmentId: EnvironmentId): HeavyCommandsState {
  const state = useAtomValue(heavyQueueEnvironment.commands({ environmentId, input: {} }));
  return Option.getOrElse(AsyncResult.value(state), () => NO_COMMANDS);
}
