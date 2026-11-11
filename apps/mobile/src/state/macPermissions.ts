import { useAtomValue } from "@effect/atom-react";
import { isComputerUseHostOs } from "@t3tools/client-runtime/state/mac-permissions";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentServerConfigsAtom } from "./server";

/** The environments whose server OS matches, as a list that keeps its identity while unchanged. */
const environmentIdsByOs = (matches: (os: string) => boolean, label: string) =>
  Atom.make((get): ReadonlyArray<EnvironmentId> => {
    const next = [...get(environmentServerConfigsAtom)]
      .filter(([, config]) => matches(config.environment.platform.os))
      .map(([environmentId]) => environmentId);
    const previous = get.self<ReadonlyArray<EnvironmentId>>();
    const prior = previous._tag === "Some" ? previous.value : null;
    return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
      ? prior
      : next;
  }).pipe(Atom.withLabel(label));

/** Environments whose server runs on a Mac, where macOS permissions decide what agents can do. */
export const macEnvironmentIdsAtom = environmentIdsByOs(
  (os) => os === "darwin",
  "mobile-mac-environment-ids",
);

/** Windows and Linux environments, which report what agents can do instead of permissions. */
export const computerUseHostEnvironmentIdsAtom = environmentIdsByOs(
  isComputerUseHostOs,
  "mobile-computer-use-host-environment-ids",
);

export function useMacEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(macEnvironmentIdsAtom);
}

export function useComputerUseHostEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(computerUseHostEnvironmentIdsAtom);
}
