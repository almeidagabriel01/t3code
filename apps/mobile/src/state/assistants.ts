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
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type Assistant,
  type AssistantSandboxStatus,
  type AssistantsCreateInput,
  type AssistantsResetInput,
  type AssistantsSetAvatarImageInput,
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

import { useEnvironmentQuery } from "./query";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession, sessionHasScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

const assistantsEnvironment = createAssistantsEnvironmentAtoms(connectionAtomRuntime);

/** Environments whose server has assistants, from the cached server config. Opens no stream. */
const assistantsEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.assistants === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-assistants-environment-ids"));

const assistantsFeedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): AsyncResult.AsyncResult<AssistantsState, unknown> =>
    sessionHasScope(
      get(environmentSession.sessionStateAtom(environmentId)),
      AuthOrchestrationReadScope,
    )
      ? get(assistantsEnvironment.live({ environmentId, input: null }))
      : AsyncResult.initial(),
  ).pipe(Atom.withLabel(`mobile-assistants-feed:${environmentId}`)),
);

const assistantStatesAtom = Atom.make((get) =>
  get(assistantsEnvironmentIdsAtom).flatMap((environmentId) => {
    const state = Option.getOrNull(AsyncResult.value(get(assistantsFeedAtom(environmentId))));
    return state === null ? [] : [[environmentId, state] as const];
  }),
).pipe(Atom.withLabel("mobile-assistant-states"));

export interface AssistantEntry {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
}

export interface AssistantTeamEntry {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
}

const assistantEntriesAtom = Atom.make((get) => {
  const active: AssistantEntry[] = [];
  const archived: AssistantEntry[] = [];
  const teams: AssistantTeamEntry[] = [];
  const environmentIds: EnvironmentId[] = [];
  for (const [environmentId, state] of get(assistantStatesAtom)) {
    environmentIds.push(environmentId);
    for (const team of selectTeams(state)) teams.push({ environmentId, team });
    for (const assistant of selectActiveAssistants(state))
      active.push({ environmentId, assistant });
    for (const assistant of selectArchivedAssistants(state)) {
      archived.push({ environmentId, assistant });
    }
  }
  return { active, archived, teams, environmentIds };
}).pipe(Atom.withLabel("mobile-assistant-entries"));

/** What an assistant spent across its conversations; idle (null) when it has no budget to show. */
export function useAssistantSpend(
  environmentId: EnvironmentId,
  assistantId: Assistant["id"] | null,
) {
  return useEnvironmentQuery(
    assistantId === null
      ? null
      : assistantsEnvironment.spend({ environmentId, input: { assistantId } }),
  );
}

/** Environments whose server has assistants. */
export function useAssistantsEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(assistantsEnvironmentIdsAtom);
}

/** Active and archived assistants of every loaded environment, listed even when it has none. */
export function useAssistantEntries() {
  return useAtomValue(assistantEntriesAtom);
}

/** The assistant whose current conversation is this thread, or null for any other thread. */
export function useThreadAssistant(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): AssistantEntry | null {
  const states = useAtomValue(assistantStatesAtom);
  if (environmentId === null || threadId === null) return null;
  const state = states.find(([id]) => id === environmentId)?.[1];
  const assistant = state ? assistantForThread(state, threadId) : undefined;
  return assistant ? { environmentId, assistant } : null;
}

export type AssistantReply<A = void> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/** Each change settles into a reply; the screen shows a refusal where it happened. */
export function useAssistantActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(assistantsEnvironment.create.permissionAtom(environmentId));
  const create = useAtomCommand(assistantsEnvironment.create, { reportFailure: false });
  const update = useAtomCommand(assistantsEnvironment.update, { reportFailure: false });
  const remove = useAtomCommand(assistantsEnvironment.delete, { reportFailure: false });
  const reset = useAtomCommand(assistantsEnvironment.reset, { reportFailure: false });
  const setAvatarImage = useAtomCommand(assistantsEnvironment.setAvatarImage, {
    reportFailure: false,
  });
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
    setAvatarImage: async (input: AssistantsSetAvatarImageInput) =>
      reply(await setAvatarImage({ environmentId, input })),
  };
}

/** Brings an old conversation back as the assistant's current one; the archive lists many environments, so this takes the environment instead of using a hook. */
export async function restoreAssistantConversation(
  environmentId: EnvironmentId,
  input: AssistantsResetInput,
): Promise<AssistantReply> {
  const result = await runAtomCommand(
    appAtomRegistry,
    assistantsEnvironment.reset,
    { environmentId, input },
    { label: "assistant restore", reportFailure: false, reportDefect: true },
  );
  return result._tag === "Success"
    ? { ok: true, value: undefined }
    : { ok: false, message: assistantErrorMessage(squashAtomCommandFailure(result)) };
}

/** Each team change settles into a reply; the screen shows a refusal where it happened. */
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

/** The messages members sent each other. */
export function useAssistantTeamActivity(environmentId: EnvironmentId, teamId: AssistantTeamId) {
  return useEnvironmentQuery(
    assistantsEnvironment.teamActivity({ environmentId, input: { teamId } }),
  );
}

const sandboxStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): AssistantSandboxStatus | null =>
    Option.getOrNull(
      AsyncResult.value(get(assistantsEnvironment.sandbox({ environmentId, input: null }))),
    ),
  ).pipe(Atom.withLabel(`mobile-assistant-sandbox:${environmentId}`)),
);

/** The sandbox container of an environment, live; null before its first report. */
export function useAssistantSandbox(environmentId: EnvironmentId): AssistantSandboxStatus | null {
  return useAtomValue(sandboxStatusAtom(environmentId));
}

/** Each action settles into a reply; the status itself arrives through `useAssistantSandbox`. */
export function useAssistantSandboxActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(assistantsEnvironment.startSandbox.permissionAtom(environmentId));
  const start = useAtomCommand(assistantsEnvironment.startSandbox, { reportFailure: false });
  const stop = useAtomCommand(assistantsEnvironment.stopSandbox, { reportFailure: false });
  const remove = useAtomCommand(assistantsEnvironment.removeSandbox, { reportFailure: false });
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
  };
}
