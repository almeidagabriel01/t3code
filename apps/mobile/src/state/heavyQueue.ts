import { useAtomValue } from "@effect/atom-react";
import { createHeavyQueueEnvironmentAtoms } from "@t3tools/client-runtime/state/heavyQueue";
import type { EnvironmentId, HeavyQueueState } from "@t3tools/contracts";
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
  machine: null,
};

/** Run order, running entries first; empty while loading or when an older server rejects it. */
export function useHeavyQueueState(environmentId: EnvironmentId): HeavyQueueState {
  const state = useAtomValue(heavyQueueEnvironment.state({ environmentId, input: {} }));
  return Option.getOrElse(AsyncResult.value(state), () => EMPTY);
}
