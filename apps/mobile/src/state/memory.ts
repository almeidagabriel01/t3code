import { useAtomValue } from "@effect/atom-react";
import { createMemoryEnvironmentAtoms } from "@t3tools/client-runtime/state/memory";
import { supportsMemoryProtocol, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

export const memoryEnvironment = createMemoryEnvironmentAtoms(connectionAtomRuntime);

const memoryEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => supportsMemoryProtocol(config.environment.capabilities))
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-memory-environment-ids"));

/** For entry points that only decide whether to show themselves. */
export function useHasMemoryEnvironments(): boolean {
  return useAtomValue(memoryEnvironmentIdsAtom).length > 0;
}
