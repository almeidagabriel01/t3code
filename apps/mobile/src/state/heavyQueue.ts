import { useAtomValue } from "@effect/atom-react";
import { createHeavyQueueEnvironmentAtoms } from "@t3tools/client-runtime/state/heavyQueue";
import type { EnvironmentId, HeavyQueueEntry } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const heavyQueueEnvironment = createHeavyQueueEnvironmentAtoms(connectionAtomRuntime);

const NO_ENTRIES: readonly HeavyQueueEntry[] = [];

/** Run order, running entry first; empty while loading or when an older server rejects it. */
export function useHeavyQueueEntries(environmentId: EnvironmentId): readonly HeavyQueueEntry[] {
  const state = useAtomValue(heavyQueueEnvironment.state({ environmentId, input: {} }));
  return Option.match(AsyncResult.value(state), {
    onNone: () => NO_ENTRIES,
    onSome: (value) => value.entries,
  });
}
