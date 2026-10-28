import { useAtomValue } from "@effect/atom-react";
import {
  createKanbanEnvironmentAtoms,
  selectKanbanThreadCards,
} from "@t3tools/client-runtime/state/kanban";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type KanbanCard,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList } from "./environmentAtomList";
import { environmentServerConfigsAtom } from "./server";
import { deriveProviderEntriesByEnvironment } from "../providerInstances";
import { environmentPresentations } from "./presentation";
import { useEnvironmentsWithScope } from "./session";

export const kanbanEnvironment = createKanbanEnvironmentAtoms(connectionAtomRuntime);

export const kanbanLiveListAtom = environmentAtomList("web-kanban-live", (environmentId) =>
  kanbanEnvironment.live({ environmentId, input: null }),
);

const kanbanEnvironmentIdsAtom = Atom.make((get) => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.kanban === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("web-kanban-environment-ids"));

/** Connected environments whose server has boards and whose session can read them. */
export function useKanbanEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const supported = useAtomValue(kanbanEnvironmentIdsAtom);
  const readable = useEnvironmentsWithScope(
    supported.map((environmentId) => ({ environmentId })),
    AuthOrchestrationReadScope,
  );
  return supported.filter((id) => readable.has(id));
}

const providerEntriesAtom = Atom.make((get) => {
  const providers = get(environmentPresentations.providersByEnvironmentAtom);
  return deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providers.get(environmentId) ?? [], config.settings] as const,
    ),
  );
}).pipe(Atom.withLabel("web-kanban-provider-entries"));

export function useProviderEntry(environmentId: EnvironmentId, instanceId: string) {
  return useAtomValue(providerEntriesAtom).get(environmentId)?.get(instanceId);
}

const threadCardsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    if (
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities.kanban !== true
    ) {
      return null;
    }
    const state = Option.getOrNull(
      AsyncResult.value(get(kanbanEnvironment.live({ environmentId, input: null }))),
    );
    return state === null ? null : selectKanbanThreadCards(state);
  }).pipe(Atom.withLabel(`web-kanban-thread-cards:${environmentId}`)),
);

/** Card objects keep their identity until that card changes, so a row only re-renders for its own. */
const threadCardAtom = Atom.family((threadKey: string) =>
  Atom.make((get): KanbanCard | null => {
    const [environmentId, threadId] = threadKey.split("\n") as [EnvironmentId, ThreadId];
    return get(threadCardsAtom(environmentId))?.get(threadId) ?? null;
  }).pipe(Atom.withLabel(`web-kanban-thread-card:${threadKey}`)),
);

/** The card a thread is linked to, if its environment has boards. */
export function useThreadKanbanCard(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): KanbanCard | null {
  return useAtomValue(threadCardAtom(`${environmentId}\n${threadId}`));
}
