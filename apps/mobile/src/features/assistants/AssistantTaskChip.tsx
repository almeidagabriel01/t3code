import {
  ASSISTANT_TASK_FACE,
  ASSISTANT_TASK_STATE_LABEL,
  assistantTaskState,
} from "@t3tools/client-runtime/assistantTasks";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useTaskAssistant } from "../../state/assistants";
import { useThreadShell } from "../../state/entities";
import { AssistantAvatar } from "./assistantPresentation";
import { useAssistantFlows } from "./useAssistantFlows";

/** The face of the assistant that launched this thread, in the mood of the work; tap goes to it. */
export function AssistantTaskChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const owner = useTaskAssistant(environmentId, threadId);
  const shell = useThreadShell(owner === null ? null : scopeThreadRef(environmentId, threadId));
  const flows = useAssistantFlows(environmentId);
  if (owner === null) return null;
  const state = shell === null ? "running" : assistantTaskState(shell);
  const label = `Task of ${owner.assistant.name}, ${ASSISTANT_TASK_STATE_LABEL[state].toLowerCase()}`;
  return (
    <View className="flex-row px-4 py-1">
      <Pressable
        testID="assistant-task-chip"
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={owner.assistant.threadId === null}
        onPress={() => flows.openConversation(owner.assistant)}
        className="flex-row items-center gap-2 rounded-full border border-border py-1 pl-1 pr-3 active:opacity-70"
      >
        <AssistantAvatar
          assistant={owner.assistant}
          environmentId={environmentId}
          mood={ASSISTANT_TASK_FACE[state]}
          size={24}
        />
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}
