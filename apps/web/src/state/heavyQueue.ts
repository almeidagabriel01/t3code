import { useAtomValue } from "@effect/atom-react";
import { createHeavyQueueEnvironmentAtoms } from "@t3tools/client-runtime/state/heavyQueue";
import type { EnvironmentId, HeavyCommandsState, HeavyQueueState } from "@t3tools/contracts";
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

const NO_COMMANDS: HeavyCommandsState = { commands: [], cpuCount: 1 };
const NO_COMMANDS_ATOM = Atom.make(NO_COMMANDS).pipe(Atom.withLabel("web-heavy-commands-none"));

const heavyCommandsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): HeavyCommandsState =>
    Option.getOrElse(
      AsyncResult.value(get(heavyQueueEnvironment.commands({ environmentId, input: {} }))),
      () => NO_COMMANDS,
    ),
  ).pipe(Atom.withLabel(`web-heavy-commands:${environmentId}`)),
);

/** Live only while mounted: subscribing keeps the server sampling processes. Empty on older servers. */
export function useHeavyCommands(environmentId: EnvironmentId | null): HeavyCommandsState {
  return useAtomValue(environmentId === null ? NO_COMMANDS_ATOM : heavyCommandsAtom(environmentId));
}
