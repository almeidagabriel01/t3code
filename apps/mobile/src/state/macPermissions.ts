import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentServerConfigsAtom } from "./server";

/** Environments whose server runs on a Mac, the only hosts where agents can use the screen. */
export const macEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.platform.os === "darwin")
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-mac-environment-ids"));

export function useMacEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(macEnvironmentIdsAtom);
}
