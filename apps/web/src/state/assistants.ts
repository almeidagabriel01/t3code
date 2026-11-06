import { useAtomValue } from "@effect/atom-react";
import {
  assistantErrorMessage,
  assistantForThread,
  createAssistantsEnvironmentAtoms,
  selectActiveAssistants,
  selectArchivedAssistants,
  selectTeams,
  type AssistantsState,
} from "@t3tools/client-runtime/state/assistants";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type Assistant,
  type AssistantsCreateInput,
  type AssistantSandboxStatus,
  type AssistantsResetInput,
  type AssistantsUpdateInput,
  type AssistantTeam,
  type AssistantTeamId,
  type AssistantTeamsCreateInput,
  type AssistantTeamsUpdateInput,
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

export interface AssistantTeamEntry {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
}

const assistantEntriesAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const active: AssistantEntry[] = [];
    const archived: AssistantEntry[] = [];
    const teams: AssistantTeamEntry[] = [];
    const environmentIds: EnvironmentId[] = [];
    for (const [environmentId, state] of get(assistantStatesAtom(key))) {
      environmentIds.push(environmentId);
      for (const team of selectTeams(state)) teams.push({ environmentId, team });
      for (const assistant of selectActiveAssistants(state))
        active.push({ environmentId, assistant });
      for (const assistant of selectArchivedAssistants(state)) {
        archived.push({ environmentId, assistant });
      }
    }
    return { active, archived, teams, environmentIds };
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

/** Active and archived assistants of every loaded environment, listed even when it has none. */
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

const sandboxStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): AssistantSandboxStatus | null =>
    Option.getOrNull(
      AsyncResult.value(get(assistantsEnvironment.sandbox({ environmentId, input: null }))),
    ),
  ).pipe(Atom.withLabel(`web-assistant-sandbox:${environmentId}`)),
);
const NO_SANDBOX_STATUS = Atom.make<AssistantSandboxStatus | null>(null).pipe(
  Atom.withLabel("web-assistant-sandbox-none"),
);

/** The sandbox container of an environment, live; null before its first report. */
export function useAssistantSandbox(
  environmentId: EnvironmentId | null,
): AssistantSandboxStatus | null {
  return useAtomValue(
    environmentId === null ? NO_SANDBOX_STATUS : sandboxStatusAtom(environmentId),
  );
}

/** Each action settles into a reply; the status itself arrives through `useAssistantSandbox`. */
export function useAssistantSandboxActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(assistantsEnvironment.startSandbox.permissionAtom(environmentId));
  const start = useAtomCommand(assistantsEnvironment.startSandbox, { reportFailure: false });
  const stop = useAtomCommand(assistantsEnvironment.stopSandbox, { reportFailure: false });
  const remove = useAtomCommand(assistantsEnvironment.removeSandbox, { reportFailure: false });
  const pairing = useAtomCommand(assistantsEnvironment.sandboxPairing, { reportFailure: false });
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
    start: async () => reply(await start({ environmentId, input: {} })),
    stop: async () => reply(await stop({ environmentId, input: {} })),
    remove: async (deleteVolumes: boolean) =>
      reply(await remove({ environmentId, input: { deleteVolumes } })),
    pairingUrl: async () => reply(await pairing({ environmentId, input: {} })),
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

/** Each change settles into a reply; the dialog shows a refusal where it happened. */
export function useAssistantTeamActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(assistantsEnvironment.createTeam.permissionAtom(environmentId));
  const create = useAtomCommand(assistantsEnvironment.createTeam, { reportFailure: false });
  const update = useAtomCommand(assistantsEnvironment.updateTeam, { reportFailure: false });
  const remove = useAtomCommand(assistantsEnvironment.deleteTeam, { reportFailure: false });
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
    create: async (input: AssistantTeamsCreateInput) =>
      reply(await create({ environmentId, input })),
    update: async (input: AssistantTeamsUpdateInput) =>
      reply(await update({ environmentId, input })),
    remove: async (teamId: AssistantTeamId) =>
      reply(await remove({ environmentId, input: { teamId } })),
  };
}

/** The messages members sent each other; refreshed when the team or its members change. */
export function useAssistantTeamActivity(environmentId: EnvironmentId, team: AssistantTeam) {
  return useEnvironmentQuery(
    assistantsEnvironment.teamActivity({ environmentId, input: { teamId: team.id } }),
  );
}
