import {
  WS_METHODS,
  type Assistant,
  type AssistantId,
  type AssistantsEvent,
  type AssistantTask,
  type AssistantTeam,
  type AssistantSandboxStatus,
  type AssistantTeamId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import { applyAssistantGroupsEvent, type AssistantGroupChatState } from "../assistantGroupChat.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export interface AssistantsState {
  readonly assistants: ReadonlyMap<AssistantId, Assistant>;
  readonly teams: ReadonlyMap<AssistantTeamId, AssistantTeam>;
  /** Threads assistants launched for real work, by thread id. */
  readonly tasks: ReadonlyMap<ThreadId, AssistantTask>;
}

/** Folds one event; the first is always a snapshot, so state starts from it. */
export function applyAssistantsEvent(
  state: AssistantsState | null,
  event: AssistantsEvent,
): AssistantsState | null {
  if (event.type === "snapshot") {
    return {
      assistants: new Map(event.assistants.map((assistant) => [assistant.id, assistant])),
      teams: new Map(event.teams.map((team) => [team.id, team])),
      tasks: new Map(event.tasks.map((task) => [task.threadId, task])),
    };
  }
  if (state === null) return null;
  if (event.type === "taskUpserted") {
    return { ...state, tasks: new Map(state.tasks).set(event.task.threadId, event.task) };
  }
  if (event.type === "teamUpserted" || event.type === "teamRemoved") {
    const teams = new Map(state.teams);
    if (event.type === "teamRemoved") teams.delete(event.teamId);
    else teams.set(event.team.id, event.team);
    return { ...state, teams };
  }
  const next = new Map(state.assistants);
  if (event.type === "removed") next.delete(event.assistantId);
  else next.set(event.assistant.id, event.assistant);
  return { ...state, assistants: next };
}

/** Oldest first, so the list does not reorder when a team is edited. */
export function selectTeams(state: AssistantsState): ReadonlyArray<AssistantTeam> {
  return [...state.teams.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

/** Jarvis first, then by creation. */
function byDefaultThenCreated(left: Assistant, right: Assistant): number {
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function selectActiveAssistants(state: AssistantsState): ReadonlyArray<Assistant> {
  return [...state.assistants.values()]
    .filter((assistant) => assistant.archivedAt === null)
    .sort(byDefaultThenCreated);
}

/** Most recently archived first. */
export function selectArchivedAssistants(state: AssistantsState): ReadonlyArray<Assistant> {
  return [...state.assistants.values()]
    .filter((assistant) => assistant.archivedAt !== null)
    .sort(
      (left, right) =>
        (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "") ||
        left.id.localeCompare(right.id),
    );
}

/** The assistant whose current conversation is this thread; old generations match none. */
export function assistantForThread(
  state: AssistantsState,
  threadId: ThreadId,
): Assistant | undefined {
  for (const assistant of state.assistants.values()) {
    if (assistant.threadId === threadId) return assistant;
  }
  return undefined;
}

/** One assistant's tasks, oldest first; the caller adds each thread's state. */
export function selectAssistantTasks(
  state: AssistantsState,
  assistantId: AssistantId,
): ReadonlyArray<AssistantTask> {
  return [...state.tasks.values()].filter((task) => task.assistantId === assistantId);
}

/** The assistant that launched this thread as a task, if any. */
export function assistantForTaskThread(
  state: AssistantsState,
  threadId: ThreadId,
): Assistant | undefined {
  const task = state.tasks.get(threadId);
  return task === undefined ? undefined : state.assistants.get(task.assistantId);
}

export interface AssistantSandboxView {
  readonly label: string;
  /** What the status adds to its label: the step in progress, or the reason it failed. */
  readonly detail: string | null;
  readonly canStart: boolean;
  readonly canStop: boolean;
  /** There is a container or files to remove. */
  readonly canRemove: boolean;
  /** Choosing the sandbox for an assistant needs Docker; this says why it cannot be chosen. */
  readonly unavailableReason: string | null;
  /** The provider sign-in link makes sense once the sandbox runs and is linked. */
  readonly canSignIn: boolean;
}

const SANDBOX_STATE_LABEL = {
  not_created: "Not created",
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  docker_unavailable: "Docker not available",
  failed: "Failed",
} as const;

/** One reading of the status for every client, so web and mobile say the same thing. */
export function assistantSandboxView(status: AssistantSandboxStatus | null): AssistantSandboxView {
  if (status === null) {
    return {
      label: "Checking",
      detail: null,
      canStart: false,
      canStop: false,
      canRemove: false,
      unavailableReason: null,
      canSignIn: false,
    };
  }
  const dockerMissing = status.state === "docker_unavailable";
  return {
    label: SANDBOX_STATE_LABEL[status.state],
    detail: status.state === "starting" ? status.step : status.error,
    canStart: status.state !== "starting" && !dockerMissing && status.state !== "running",
    canStop: status.state === "running",
    canRemove: status.state !== "not_created" && status.state !== "starting" && !dockerMissing,
    unavailableReason: dockerMissing ? "Docker is not running on that machine." : null,
    canSignIn: status.state === "running" && status.environmentId !== null,
  };
}

export const SANDBOX_GITHUB_DESCRIPTION =
  "Lets work in the sandbox clone and push your private GitHub repositories. It does not use this Mac's GitHub sign-in.";

export interface AssistantSandboxGithubView {
  readonly label: string;
  /** Why the last sign-in did not finish. */
  readonly detail: string | null;
  /** The one button the row shows; "cancel" stops a sign-in that waits for the code. */
  readonly action: "sign_in" | "sign_out" | "cancel" | null;
  /** While signing in: the code to enter, and where. */
  readonly userCode: string | null;
  readonly verificationUri: string | null;
}

export function assistantSandboxGithubView(
  status: AssistantSandboxStatus | null,
): AssistantSandboxGithubView {
  const github = status?.github;
  const base = { detail: github?.error ?? null, userCode: null, verificationUri: null };
  switch (github?.state) {
    case undefined:
    case "unavailable":
      return { ...base, label: "Start the sandbox to sign in", action: null };
    case "signed_out":
      return { ...base, label: "Not signed in", action: "sign_in" };
    case "signing_in":
      return {
        ...base,
        label:
          github.userCode === null
            ? "Asking GitHub for a code"
            : "Enter this code on GitHub to finish signing in",
        action: "cancel",
        userCode: github.userCode,
        verificationUri: github.verificationUri,
      };
    case "signed_in":
      return {
        ...base,
        label: github.login === null ? "Signed in" : `Signed in as ${github.login}`,
        action: "sign_out",
      };
  }
}

const SANDBOX_CPU_PRESETS = [1, 2, 4, 8, 16];

export const SANDBOX_CPU_DESCRIPTION =
  "The most CPU cores the container may use. It applies at once, also to a running container.";

export function sandboxCpuLabel(cpus: number | null): string {
  return cpus === null ? "No limit" : `${cpus} ${cpus === 1 ? "core" : "cores"}`;
}

/** The presets, plus the current limit when it is not one of them, so a stored value always shows. */
export function sandboxCpuChoices(
  current: number | null,
): ReadonlyArray<{ readonly value: number | null; readonly label: string }> {
  const counts =
    current === null || SANDBOX_CPU_PRESETS.includes(current)
      ? SANDBOX_CPU_PRESETS
      : [...SANDBOX_CPU_PRESETS, current].sort((left, right) => left - right);
  return [null, ...counts].map((value) => ({ value, label: sandboxCpuLabel(value) }));
}

export const SANDBOX_WHEN_DONE_DESCRIPTION =
  "A container started only for one task goes away when its last task ends; its files and provider sign-ins stay. One you started yourself is never discarded.";

export const SANDBOX_WHEN_DONE_CHOICES = [
  { value: "discard", label: "Discard the container" },
  { value: "keep", label: "Keep the container" },
] as const;

function assistantsStateStream<E, R>(
  events: Stream.Stream<AssistantsEvent, E, R>,
): Stream.Stream<AssistantsState, E, R> {
  return events.pipe(
    Stream.scan((): AssistantsState | null => null, applyAssistantsEvent),
    Stream.filter((state): state is AssistantsState => state !== null),
  );
}

/** The message a refused assistant change shows inline. */
export function assistantErrorMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message
    ? error.message
    : "The assistant request failed. Try again.";
}

export function createAssistantsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One lane per environment keeps edits applied in the order they were made.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial",
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  } as const;
  const command = <
    TTag extends
      | typeof WS_METHODS.assistantsCreate
      | typeof WS_METHODS.assistantsUpdate
      | typeof WS_METHODS.assistantsDelete
      | typeof WS_METHODS.assistantsReset
      | typeof WS_METHODS.assistantsSetAvatarImage
      | typeof WS_METHODS.assistantsSetTaskDismissed
      | typeof WS_METHODS.assistantTeamsCreate
      | typeof WS_METHODS.assistantTeamsUpdate
      | typeof WS_METHODS.assistantTeamsDelete
      | typeof WS_METHODS.assistantGroupsPost
      | typeof WS_METHODS.assistantGroupsTaskAction
      | typeof WS_METHODS.assistantGroupsHistory
      | typeof WS_METHODS.assistantGroupsMarkRead
      | typeof WS_METHODS.assistantGroupsConversation
      | typeof WS_METHODS.assistantSandboxStart
      | typeof WS_METHODS.assistantSandboxStop
      | typeof WS_METHODS.assistantSandboxRemove
      | typeof WS_METHODS.assistantSandboxConfigure
      | typeof WS_METHODS.assistantSandboxGithubSignIn
      | typeof WS_METHODS.assistantSandboxGithubSignOut
      | typeof WS_METHODS.assistantSandboxPairing,
  >(
    tag: TTag,
    name: string,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:assistants:${name}`,
      tag,
      scheduler,
      concurrency,
    });
  return {
    live: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:assistants:live",
      subscribe: (_input: null) =>
        assistantsStateStream(subscribe(WS_METHODS.assistantsSubscribe, {})),
    }),
    create: command(WS_METHODS.assistantsCreate, "create"),
    update: command(WS_METHODS.assistantsUpdate, "update"),
    delete: command(WS_METHODS.assistantsDelete, "delete"),
    reset: command(WS_METHODS.assistantsReset, "reset"),
    setAvatarImage: command(WS_METHODS.assistantsSetAvatarImage, "setAvatarImage"),
    setTaskDismissed: command(WS_METHODS.assistantsSetTaskDismissed, "setTaskDismissed"),
    createTeam: command(WS_METHODS.assistantTeamsCreate, "createTeam"),
    updateTeam: command(WS_METHODS.assistantTeamsUpdate, "updateTeam"),
    deleteTeam: command(WS_METHODS.assistantTeamsDelete, "deleteTeam"),
    /** One group's chat, live: the newest page first, then each change. */
    groupChat: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:assistants:group-chat",
      subscribe: (input: { readonly teamId: AssistantTeamId }) =>
        subscribe(WS_METHODS.assistantGroupsSubscribe, input).pipe(
          Stream.scan((): AssistantGroupChatState | null => null, applyAssistantGroupsEvent),
          Stream.filter((state): state is AssistantGroupChatState => state !== null),
        ),
    }),
    groupHistory: command(WS_METHODS.assistantGroupsHistory, "groupHistory"),
    markGroupRead: command(WS_METHODS.assistantGroupsMarkRead, "markGroupRead"),
    groupConversation: command(WS_METHODS.assistantGroupsConversation, "groupConversation"),
    postGroup: command(WS_METHODS.assistantGroupsPost, "postGroup"),
    groupTaskAction: command(WS_METHODS.assistantGroupsTaskAction, "groupTaskAction"),
    sandbox: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:assistants:sandbox",
      subscribe: (_input: null) => subscribe(WS_METHODS.assistantSandboxSubscribe, {}),
    }),
    startSandbox: command(WS_METHODS.assistantSandboxStart, "startSandbox"),
    stopSandbox: command(WS_METHODS.assistantSandboxStop, "stopSandbox"),
    removeSandbox: command(WS_METHODS.assistantSandboxRemove, "removeSandbox"),
    configureSandbox: command(WS_METHODS.assistantSandboxConfigure, "configureSandbox"),
    sandboxPairing: command(WS_METHODS.assistantSandboxPairing, "sandboxPairing"),
    sandboxGithubSignIn: command(WS_METHODS.assistantSandboxGithubSignIn, "sandboxGithubSignIn"),
    sandboxGithubSignOut: command(WS_METHODS.assistantSandboxGithubSignOut, "sandboxGithubSignOut"),
    spend: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:assistants:spend",
      tag: WS_METHODS.assistantsSpend,
      staleTimeMs: 60_000,
    }),
    /** Files it handed over or received, newest first. */
    library: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:assistants:library",
      tag: WS_METHODS.assistantsLibrary,
      staleTimeMs: 30_000,
    }),
  };
}
