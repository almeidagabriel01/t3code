import { assistantAttention, assistantGroupAttention } from "@t3tools/client-runtime/assistantList";
import { assistantGroupThreadsOf } from "@t3tools/client-runtime/assistantRobot";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { hasUnseenCompletion } from "@t3tools/client-runtime/state/thread-attention";

import type { AssistantEntry, AssistantTeamEntry } from "../../state/assistants";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useQuietThreadShells, useThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";

/** An assistant's conversation as the user last saw it, its group threads, and its status. */
export function useAssistantAttention(entry: AssistantEntry) {
  const { assistant, environmentId } = entry;
  const threadRef =
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId);
  const thread = useThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore((state) =>
    threadRef === null ? undefined : state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const shells = useQuietThreadShells();
  const openDecisions = useOpenDecisionThreadKeys();
  const groupThreads = assistantGroupThreadsOf(shells, environmentId, assistant.id);
  const visited =
    thread === null
      ? null
      : {
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
        };
  // Its own conversation and its group work; only the conversation it opens can be unseen.
  const attention = assistantAttention({
    threads: visited === null ? groupThreads : [visited, ...groupThreads],
    hasOpenDecision: (candidate) =>
      openDecisions.has(scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id))),
    unseenDone: visited !== null && hasUnseenCompletion(visited),
  });
  return { threadRef, thread, visited, groupThreads, attention };
}

/** How to read a group's status from its members' conversations, its threads and its tasks. */
export function useGroupAttention() {
  const shells = useQuietThreadShells();
  const openDecisions = useOpenDecisionThreadKeys();
  return (team: AssistantTeamEntry, members: ReadonlyArray<AssistantEntry>) =>
    assistantGroupAttention({
      shells,
      hasOpenDecision: (thread) =>
        openDecisions.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      environmentId: team.environmentId,
      memberThreadIds: members.map((member) => member.assistant.threadId),
      chat: team.team.chat,
    });
}
