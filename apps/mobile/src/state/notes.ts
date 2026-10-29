import { useAtomValue } from "@effect/atom-react";
import { createNotesEnvironmentAtoms, type NotesState } from "@t3tools/client-runtime/state/notes";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession, sessionHasScope } from "./session";

export const notesEnvironment = createNotesEnvironmentAtoms(connectionAtomRuntime);

/**
 * Environments whose server has notes, from the cached server config so offline drafts stay
 * reachable. Opens no stream.
 */
const notesEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.notes === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-notes-environment-ids"));

export function useNotesEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(notesEnvironmentIdsAtom);
}

/** For entry points that only decide whether to show themselves. */
export function useHasNotesEnvironments(): boolean {
  return useAtomValue(notesEnvironmentIdsAtom).length > 0;
}

const notesFeedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): AsyncResult.AsyncResult<NotesState, unknown> =>
    sessionHasScope(
      get(environmentSession.sessionStateAtom(environmentId)),
      AuthOrchestrationReadScope,
    )
      ? get(notesEnvironment.live({ environmentId, input: null }))
      : AsyncResult.initial(),
  ).pipe(Atom.withLabel(`mobile-notes-feed:${environmentId}`)),
);

/** The live note list, or still initial while the session cannot read it. */
export function useNotesFeed(environmentId: EnvironmentId) {
  return useAtomValue(notesFeedAtom(environmentId));
}
