import { useAtomValue } from "@effect/atom-react";
import {
  assistantErrorMessage,
  assistantForThread,
  createAssistantsEnvironmentAtoms,
  selectActiveAssistants,
  selectArchivedAssistants,
  type AssistantsState,
} from "@t3tools/client-runtime/state/assistants";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type Assistant,
  type AssistantsCreateInput,
  type AssistantsResetInput,
  type AssistantsUpdateInput,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { environmentServerConfigsAtom } from "./server";
import { useEnvironmentsWithScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

const assistantsEnvironment = createAssistantsEnvironmentAtoms(connectionAtomRuntime);

const assistantsLiveListAtom = environmentAtomList("web-assistants-live", (environmentId) =>
  assistantsEnvironment.live({ environmentId, input: null }),
);

const assistantsEnvironmentIdsAtom = Atom.make((get) => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.assistants === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("web-assistants-environment-ids"));

/** Connected environments whose server has assistants and whose session can read them. */
export function useAssistantsEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const supported = useAtomValue(assistantsEnvironmentIdsAtom);
  const readable = useEnvironmentsWithScope(
    supported.map((environmentId) => ({ environmentId })),
    AuthOrchestrationReadScope,
  );
  return supported.filter((id) => readable.has(id));
}

const assistantStatesAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const ids = key === "" ? [] : (key.split("\n") as EnvironmentId[]);
    return get(assistantsLiveListAtom(key)).flatMap((result, index) => {
      const state = Option.getOrNull(AsyncResult.value(result));
      return state === null ? [] : [[ids[index]!, state] as const];
    }) satisfies ReadonlyArray<readonly [EnvironmentId, AssistantsState]>;
  }).pipe(Atom.withLabel(`web-assistant-states:${key}`)),
);

export interface AssistantEntry {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
}

const assistantEntriesAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const active: AssistantEntry[] = [];
    const archived: AssistantEntry[] = [];
    for (const [environmentId, state] of get(assistantStatesAtom(key))) {
      for (const assistant of selectActiveAssistants(state))
        active.push({ environmentId, assistant });
      for (const assistant of selectArchivedAssistants(state)) {
        archived.push({ environmentId, assistant });
      }
    }
    return { active, archived };
  }).pipe(Atom.withLabel(`web-assistant-entries:${key}`)),
);

const threadAssistantAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [environmentKey, threadId] = key.split("\u0000") as [string, ThreadId];
    for (const [environmentId, state] of get(assistantStatesAtom(environmentKey))) {
      const assistant = assistantForThread(state, threadId);
      if (assistant) return { environmentId, assistant } satisfies AssistantEntry;
    }
    return null;
  }).pipe(Atom.withLabel(`web-thread-assistant:${key}`)),
);

/** Active and archived assistants across the environments that have them; Jarvis first. */
export function useAssistantEntries() {
  return useAtomValue(assistantEntriesAtom(environmentIdsKey(useAssistantsEnvironmentIds())));
}

/** The assistant whose current conversation is this thread, or null for any other thread. */
export function useThreadAssistant(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): AssistantEntry | null {
  const environmentIds = useAssistantsEnvironmentIds();
  const key = `${environmentIdsKey(environmentId === null ? [] : environmentIds.filter((id) => id === environmentId))}\u0000${threadId ?? ""}`;
  return useAtomValue(threadAssistantAtom(key));
}

export type AssistantReply<A = void> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/** Each change settles into a reply; the form shows a refusal where it happened. */
export function useAssistantActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(assistantsEnvironment.create.permissionAtom(environmentId));
  const create = useAtomCommand(assistantsEnvironment.create, { reportFailure: false });
  const update = useAtomCommand(assistantsEnvironment.update, { reportFailure: false });
  const remove = useAtomCommand(assistantsEnvironment.delete, { reportFailure: false });
  const reset = useAtomCommand(assistantsEnvironment.reset, { reportFailure: false });
  const reply = <A>(
    result:
      | { readonly _tag: "Success"; readonly value: A }
      | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
  ): AssistantReply<A> =>
    result._tag === "Success"
      ? { ok: true, value: result.value }
      : { ok: false, message: assistantErrorMessage(squashAtomCommandFailure(result)) };
  return {
    canAct,
    create: async (input: AssistantsCreateInput) => reply(await create({ environmentId, input })),
    update: async (input: AssistantsUpdateInput) => reply(await update({ environmentId, input })),
    remove: async (assistantId: Assistant["id"]) =>
      reply(await remove({ environmentId, input: { assistantId } })),
    reset: async (input: AssistantsResetInput) => reply(await reset({ environmentId, input })),
  };
}

/** What the assistant spent across every conversation; no request while `assistantId` is null. */
export function useAssistantSpend(
  environmentId: EnvironmentId,
  assistantId: Assistant["id"] | null,
) {
  return useEnvironmentQuery(
    assistantId === null
      ? null
      : assistantsEnvironment.spend({ environmentId, input: { assistantId } }),
  ).data;
}
