import {
  WS_METHODS,
  type Assistant,
  type AssistantId,
  type AssistantsEvent,
  type AssistantTeam,
  type AssistantTeamId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

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
    };
  }
  if (state === null) return null;
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
      | typeof WS_METHODS.assistantTeamsCreate
      | typeof WS_METHODS.assistantTeamsUpdate
      | typeof WS_METHODS.assistantTeamsDelete,
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
    createTeam: command(WS_METHODS.assistantTeamsCreate, "createTeam"),
    updateTeam: command(WS_METHODS.assistantTeamsUpdate, "updateTeam"),
    deleteTeam: command(WS_METHODS.assistantTeamsDelete, "deleteTeam"),
    teamActivity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:assistants:teamActivity",
      tag: WS_METHODS.assistantTeamsActivity,
      staleTimeMs: 10_000,
    }),
    spend: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:assistants:spend",
      tag: WS_METHODS.assistantsSpend,
      staleTimeMs: 60_000,
    }),
  };
}
