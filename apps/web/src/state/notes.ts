import { useAtomValue } from "@effect/atom-react";
import { createNotesEnvironmentAtoms } from "@t3tools/client-runtime/state/notes";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";
import { useEnvironmentsWithScope } from "./session";

export const notesEnvironment = createNotesEnvironmentAtoms(connectionAtomRuntime);

const notesEnvironmentIdsAtom = Atom.make((get) => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.notes === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("web-notes-environment-ids"));

/** Connected environments whose server has notes and whose session can read them. */
export function useNotesEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const supported = useAtomValue(notesEnvironmentIdsAtom);
  const readable = useEnvironmentsWithScope(
    supported.map((environmentId) => ({ environmentId })),
    AuthOrchestrationReadScope,
  );
  return supported.filter((id) => readable.has(id));
}
