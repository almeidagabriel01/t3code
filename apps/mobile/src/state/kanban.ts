import { useAtomValue } from "@effect/atom-react";
import {
  createKanbanEnvironmentAtoms,
  selectKanbanThreadCards,
  type KanbanState,
} from "@t3tools/client-runtime/state/kanban";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type KanbanCard,
  type ThreadId,
} from "@t3tools/contracts";
import { kanbanCardRecordForThread } from "@t3tools/client-runtime/state/kanbanLogic";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession, sessionHasScope } from "./session";

export const kanbanEnvironment = createKanbanEnvironmentAtoms(connectionAtomRuntime);

export interface KanbanEnvironmentState {
  readonly environmentId: EnvironmentId;
  readonly state: KanbanState | null;
  readonly error: boolean;
}

/** Environments whose server has boards and whose session can read them. Opens no stream. */
const kanbanEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const ids: EnvironmentId[] = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.kanban !== true) continue;
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (sessionHasScope(session, AuthOrchestrationReadScope)) ids.push(environmentId);
  }
  return ids;
}).pipe(Atom.withLabel("mobile-kanban-environment-ids"));

/** For entry points that only decide whether to show themselves. */
export function useHasKanbanEnvironments(): boolean {
  return useAtomValue(kanbanEnvironmentIdsAtom).length > 0;
}

const kanbanStatesAtom = Atom.make((get): ReadonlyArray<KanbanEnvironmentState> =>
  get(kanbanEnvironmentIdsAtom).map((environmentId) => {
    const result = get(kanbanEnvironment.live({ environmentId, input: null }));
    return {
      environmentId,
      state: Option.getOrNull(AsyncResult.value(result)),
      error: result._tag === "Failure",
    };
  }),
).pipe(Atom.withLabel("mobile-kanban-states"));

export function useKanbanStates(): ReadonlyArray<KanbanEnvironmentState> {
  return useAtomValue(kanbanStatesAtom);
}

const threadCardAtom = Atom.family((threadKey: string) =>
  Atom.make((get): KanbanCard | null => {
    const [environmentId, threadId] = threadKey.split("\n") as [EnvironmentId, ThreadId];
    const config = get(environmentServerConfigsAtom).get(environmentId);
    if (config?.environment.capabilities.kanban !== true) return null;
    const state = Option.getOrNull(
      AsyncResult.value(get(kanbanEnvironment.live({ environmentId, input: null }))),
    );
    return state === null ? null : (selectKanbanThreadCards(state).get(threadId) ?? null);
  }).pipe(Atom.withLabel(`mobile-kanban-thread-card:${threadKey}`)),
);

/** The card a thread is linked to, if its environment has boards. */
export function useThreadKanbanCard(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): KanbanCard | null {
  return useAtomValue(threadCardAtom(`${environmentId}\n${threadId}`));
}

/** The card record a send should carry for a thread linked to a card, read at dispatch time. */
export function readThreadKanbanCardRecord(environmentId: EnvironmentId, threadId: ThreadId) {
  if (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .kanban !== true
  ) {
    return undefined;
  }
  const state = Option.getOrNull(
    AsyncResult.value(appAtomRegistry.get(kanbanEnvironment.live({ environmentId, input: null }))),
  );
  return kanbanCardRecordForThread(state, threadId);
}
