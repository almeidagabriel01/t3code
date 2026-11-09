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
import {
  oldestAssistantGroupSeq,
  type AssistantGroupChatState,
} from "@t3tools/client-runtime/assistantGroupChat";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type Assistant,
  type AssistantGroupConversationAction,
  type AssistantGroupsHistoryResult,
  type AssistantGroupsPostInput,
  type AssistantGroupsPostResult,
  type AssistantGroupsTaskActionInput,
  type AssistantGroupTask,
  type AssistantSandboxConfigureInput,
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
  const activeTeams: AssistantTeamEntry[] = [];
  const archivedTeams: AssistantTeamEntry[] = [];
  const environmentIds: EnvironmentId[] = [];
  for (const [environmentId, state] of get(assistantStatesAtom)) {
    environmentIds.push(environmentId);
    for (const team of selectTeams(state)) {
      teams.push({ environmentId, team });
      (team.archivedAt === null ? activeTeams : archivedTeams).push({ environmentId, team });
    }
    for (const assistant of selectActiveAssistants(state))
      active.push({ environmentId, assistant });
    for (const assistant of selectArchivedAssistants(state)) {
      archived.push({ environmentId, assistant });
    }
  }
  return { active, archived, teams, activeTeams, archivedTeams, environmentIds };
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

/** Files the assistant handed over or received through the shared folder. */
export function useAssistantLibrary(environmentId: EnvironmentId, assistantId: Assistant["id"]) {
  return useEnvironmentQuery(
    assistantsEnvironment.library({ environmentId, input: { assistantId } }),
  );
}

/** Environments whose server has assistants. */
export function useAssistantsEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(assistantsEnvironmentIdsAtom);
}

/** Active and archived assistants of every loaded environment, listed even when it has none. `teams` holds every group; Home lists `activeTeams` and Settings adds `archivedTeams`. */
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
  const configure = useAtomCommand(assistantsEnvironment.configureSandbox, {
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
    start: async () => reply(await start({ environmentId, input: {} })),
    stop: async () => reply(await stop({ environmentId, input: {} })),
    remove: async (deleteVolumes: boolean) =>
      reply(await remove({ environmentId, input: { deleteVolumes } })),
    configure: async (input: AssistantSandboxConfigureInput) =>
      reply(await configure({ environmentId, input })),
  };
}

/** One group's chat, live: null before its first snapshot. */
export function useAssistantGroupChat(
  environmentId: EnvironmentId,
  teamId: AssistantTeamId,
): AssistantGroupChatState | null {
  return Option.getOrNull(
    AsyncResult.value(
      useAtomValue(assistantsEnvironment.groupChat({ environmentId, input: { teamId } })),
    ),
  );
}

export type AssistantGroupPostReply =
  | { readonly ok: true; readonly value: AssistantGroupsPostResult }
  | { readonly ok: false; readonly message: string; readonly reason: string | null };

/** Posting, paging and task actions of one group chat; refusals come back as replies. */
export function useAssistantGroupActions(environmentId: EnvironmentId) {
  const canPost = useAtomValue(assistantsEnvironment.postGroup.permissionAtom(environmentId));
  const canAct = useAtomValue(assistantsEnvironment.groupTaskAction.permissionAtom(environmentId));
  const canMarkRead = useAtomValue(
    assistantsEnvironment.markGroupRead.permissionAtom(environmentId),
  );
  const post = useAtomCommand(assistantsEnvironment.postGroup, { reportFailure: false });
  const taskAction = useAtomCommand(assistantsEnvironment.groupTaskAction, {
    reportFailure: false,
  });
  const history = useAtomCommand(assistantsEnvironment.groupHistory, { reportFailure: false });
  const markRead = useAtomCommand(assistantsEnvironment.markGroupRead, { reportFailure: false });
  const converse = useAtomCommand(assistantsEnvironment.groupConversation, {
    reportFailure: false,
  });
  return {
    canPost,
    canAct,
    canMarkRead,
    canConverse: useAtomValue(
      assistantsEnvironment.groupConversation.permissionAtom(environmentId),
    ),
    /** New conversation, compact, undo or clear; the chat follows through its own stream. */
    conversation: async (
      teamId: AssistantTeamId,
      action: AssistantGroupConversationAction,
    ): Promise<AssistantReply> => {
      const result = await converse({ environmentId, input: { teamId, action } });
      return result._tag === "Success"
        ? { ok: true, value: undefined }
        : { ok: false, message: assistantErrorMessage(squashAtomCommandFailure(result)) };
    },
    /** Moves the read position; `readSeq` is a message number, `unread` marks the newest unread. */
    markRead: async (
      teamId: AssistantTeamId,
      position: { readonly readSeq: number } | { readonly unread: true },
    ): Promise<AssistantReply> => {
      const result = await markRead({ environmentId, input: { teamId, ...position } });
      return result._tag === "Success"
        ? { ok: true, value: undefined }
        : { ok: false, message: assistantErrorMessage(squashAtomCommandFailure(result)) };
    },
    post: async (input: AssistantGroupsPostInput): Promise<AssistantGroupPostReply> => {
      const result = await post({ environmentId, input });
      if (result._tag === "Success") return { ok: true, value: result.value };
      const error = squashAtomCommandFailure(result);
      const reason =
        typeof error === "object" && error !== null && "reason" in error
          ? String(error.reason)
          : null;
      return { ok: false, message: assistantErrorMessage(error), reason };
    },
    taskAction: async (
      input: AssistantGroupsTaskActionInput,
    ): Promise<AssistantReply<AssistantGroupTask>> => {
      const result = await taskAction({ environmentId, input });
      return result._tag === "Success"
        ? { ok: true, value: result.value }
        : { ok: false, message: assistantErrorMessage(squashAtomCommandFailure(result)) };
    },
    /** The page before the oldest loaded message. */
    olderThan: async (
      teamId: AssistantTeamId,
      state: AssistantGroupChatState,
    ): Promise<AssistantReply<AssistantGroupsHistoryResult>> => {
      const beforeSeq = oldestAssistantGroupSeq(state) ?? undefined;
      const result = await history({
        environmentId,
        input: { teamId, ...(beforeSeq === undefined ? {} : { beforeSeq }) },
      });
      return result._tag === "Success"
        ? { ok: true, value: result.value }
        : { ok: false, message: assistantErrorMessage(squashAtomCommandFailure(result)) };
    },
  };
}
