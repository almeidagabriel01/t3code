import { useAtomValue } from "@effect/atom-react";
import {
  assistantErrorMessage,
  assistantForTaskThread,
  assistantForThread,
  createAssistantsEnvironmentAtoms,
  selectAssistantTasks,
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
  type AssistantTask,
  type AssistantGroupConversationAction,
  type AssistantGroupsHistoryResult,
  type AssistantGroupsPostInput,
  type AssistantGroupsPostResult,
  type AssistantGroupsTaskActionInput,
  type AssistantGroupTask,
  type AssistantsCreateInput,
  type AssistantSandboxConfigureInput,
  type AssistantSandboxStatus,
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

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
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
    const activeTeams: AssistantTeamEntry[] = [];
    const archivedTeams: AssistantTeamEntry[] = [];
    const environmentIds: EnvironmentId[] = [];
    for (const [environmentId, state] of get(assistantStatesAtom(key))) {
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

const assistantTasksAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [environmentId, assistantId] = key.split("\u0000") as [EnvironmentId, Assistant["id"]];
    return get(assistantStatesAtom(environmentId)).flatMap(([, state]) =>
      selectAssistantTasks(state, assistantId),
    );
  }).pipe(Atom.withLabel(`web-assistant-tasks:${key}`)),
);

/** The threads this assistant launched for real work, oldest first. */
export function useAssistantTasks(
  environmentId: EnvironmentId,
  assistantId: Assistant["id"],
): ReadonlyArray<AssistantTask> {
  return useAtomValue(assistantTasksAtom(`${environmentId}\u0000${assistantId}`));
}

const taskAssistantAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [environmentId, threadId] = key.split("\u0000") as [EnvironmentId, ThreadId];
    for (const [, state] of get(assistantStatesAtom(environmentId))) {
      const assistant = assistantForTaskThread(state, threadId);
      if (assistant) return { environmentId, assistant } satisfies AssistantEntry;
    }
    return null;
  }).pipe(Atom.withLabel(`web-task-assistant:${key}`)),
);

/** The assistant that launched this thread as a task, or null for any other thread. */
export function useTaskAssistant(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): AssistantEntry | null {
  return useAtomValue(taskAssistantAtom(`${environmentId}\u0000${threadId}`));
}

const assistantTaskAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [environmentId, threadId] = key.split("\u0000") as [EnvironmentId, ThreadId];
    for (const [, state] of get(assistantStatesAtom(environmentId))) {
      const task = state.tasks.get(threadId);
      if (task) return task;
    }
    return null;
  }).pipe(Atom.withLabel(`web-assistant-task:${key}`)),
);

/** One read, for menus built on demand. */
export function readAssistantTask(environmentId: EnvironmentId, threadId: ThreadId) {
  return appAtomRegistry.get(assistantTaskAtom(`${environmentId}\u0000${threadId}`));
}

/** Takes the environment instead of a hook: thread menus act on threads of any environment. */
export async function setAssistantTaskDismissed(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  dismissed: boolean,
): Promise<AssistantReply> {
  const result = await runAtomCommand(
    appAtomRegistry,
    assistantsEnvironment.setTaskDismissed,
    { environmentId, input: { threadId, dismissed } },
    { label: "assistant task dismiss", reportFailure: false, reportDefect: true },
  );
  return result._tag === "Success"
    ? { ok: true, value: undefined }
    : { ok: false, message: assistantErrorMessage(squashAtomCommandFailure(result)) };
}

/** The link of this thread to the assistant that launched it, dismissed or not. */
export function useAssistantTask(environmentId: EnvironmentId, threadId: ThreadId) {
  return useAtomValue(assistantTaskAtom(`${environmentId}\u0000${threadId}`));
}

/** Active and archived assistants of every loaded environment, listed even when it has none. `teams` holds every group; the sidebar lists `activeTeams` and the pages add `archivedTeams`. */
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
  const configure = useAtomCommand(assistantsEnvironment.configureSandbox, {
    reportFailure: false,
  });
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
    configure: async (input: AssistantSandboxConfigureInput) =>
      reply(await configure({ environmentId, input })),
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

/** Files it handed over or received through the shared folder. */
export function useAssistantLibrary(environmentId: EnvironmentId, assistantId: Assistant["id"]) {
  return useEnvironmentQuery(
    assistantsEnvironment.library({ environmentId, input: { assistantId } }),
  );
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

/** The chat's live state, or null before the first snapshot. */
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

/** The groups of every connected environment, for what must watch them outside a component. */
export const assistantTeamEntriesAtom = Atom.make(
  (get): ReadonlyArray<AssistantTeamEntry> =>
    get(assistantEntriesAtom(environmentIdsKey(get(assistantsEnvironmentIdsAtom)))).teams,
).pipe(Atom.withLabel("web-assistant-team-entries"));

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
