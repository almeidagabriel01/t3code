import { useAtomValue } from "@effect/atom-react";
import { createHeavyQueueEnvironmentAtoms } from "@t3tools/client-runtime/state/heavyQueue";
import type { EnvironmentId, HeavyQueueState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const heavyQueueEnvironment = createHeavyQueueEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_QUEUE: HeavyQueueState = {
  entries: [],
  enabled: true,
  paused: false,
  rules: [],
  maxRunning: 1,
  reasons: {},
  room: true,
  machine: null,
};
const NO_QUEUE = Atom.make(EMPTY_QUEUE).pipe(Atom.withLabel("web-heavy-queue-none"));

const heavyQueueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): HeavyQueueState =>
    Option.getOrElse(
      AsyncResult.value(get(heavyQueueEnvironment.state({ environmentId, input: {} }))),
      () => EMPTY_QUEUE,
    ),
  ).pipe(Atom.withLabel(`web-heavy-queue:${environmentId}`)),
);

/** Empty while loading, without an environment, or on an older server whose subscription fails. */
export function useHeavyQueue(environmentId: EnvironmentId | null): HeavyQueueState {
  return useAtomValue(environmentId === null ? NO_QUEUE : heavyQueueAtom(environmentId));
}
