import {
  assistantAttention,
  assistantGroupAttention,
  type AssistantAttention,
} from "@t3tools/client-runtime/assistantList";
import { assistantGroupThreadsOf, assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import type { AssistantEntry, AssistantTeamEntry } from "../../state/assistants";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useQuietThreadShells, useThreadShell } from "../../state/entities";
import { threadHasUnseenCompletion } from "../threads/threadListV2";
import { assistantStatusLabel } from "../threads/threadStatusLabels";

/** An assistant's presence and status: its own conversation first, then its work in its groups. */
export function useAssistantAttention({ assistant, environmentId }: AssistantEntry) {
  const thread = useThreadShell(
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId),
  );
  const shells = useQuietThreadShells();
  const openDecisions = useOpenDecisionThreadKeys();
  const groupThreads = assistantGroupThreadsOf(shells, environmentId, assistant.id);
  const attention = assistantAttention({
    threads: thread === null ? groupThreads : [thread, ...groupThreads],
    hasOpenDecision: (candidate) =>
      openDecisions.has(scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id))),
    unseenDone: thread !== null && threadHasUnseenCompletion(thread),
  });
  return { thread, presence: assistantPresence(thread, groupThreads), attention };
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

/** "Name, Status" for a screen reader, or the name alone when nothing is going on. */
export function attentionAccessibilityLabel(name: string, attention: AssistantAttention | null) {
  return attention === null ? name : `${name}, ${assistantStatusLabel(attention).label}`;
}

/** A thread row's status icon and word, for an assistant or a group. */
export function AssistantStatus(props: {
  readonly attention: AssistantAttention;
  readonly testID: string;
}) {
  const label = assistantStatusLabel(props.attention);
  return (
    <View testID={props.testID} className="flex-row items-center gap-1">
      <SymbolView
        name={label.icon}
        size={13}
        tintColorClassName={label.iconTintClassName}
        type="monochrome"
        weight="semibold"
      />
      <Text className={cn("text-xs font-t3-bold", label.className)}>{label.label}</Text>
    </View>
  );
}
