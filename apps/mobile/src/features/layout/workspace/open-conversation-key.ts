import { AssistantTeamId, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../../../lib/scopedEntities";
import { assistantGroupDraftKey } from "../../../state/assistant-group-draft-key";

type Route = { readonly name: string; readonly params?: object };

const stringParam = (params: object, name: string): string | null => {
  const value: unknown = (params as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
};

/**
 * The draft key of the conversation on screen: a thread's (assistants' included) or a group
 * chat's. A group's key is thread-shaped, so thread rows never match it.
 */
export function openConversationKey(state: {
  readonly index: number;
  readonly routes: readonly Route[];
}): string | null {
  const route = state.routes
    .slice(0, state.index + 1)
    .findLast(
      (candidate) => candidate.name.startsWith("Thread") || candidate.name === "AssistantGroupChat",
    );
  if (route?.params === undefined) return null;
  const environmentId = stringParam(route.params, "environmentId");
  const group = route.name === "AssistantGroupChat";
  const localId = stringParam(route.params, group ? "teamId" : "threadId");
  if (environmentId === null || localId === null) return null;
  try {
    return group
      ? assistantGroupDraftKey(EnvironmentId.make(environmentId), AssistantTeamId.make(localId))
      : scopedThreadKey(EnvironmentId.make(environmentId), ThreadId.make(localId));
  } catch {
    // A deep link can carry ids the brands refuse; nothing is open then.
    return null;
  }
}
