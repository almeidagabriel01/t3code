import {
  ASSISTANT_TASK_FACE,
  ASSISTANT_TASK_STATE_LABEL,
  assistantTaskState,
  canDismissAssistantTask,
} from "@t3tools/client-runtime/assistantTasks";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useAssistantTask, useTaskAssistant } from "../../state/assistants";
import { useThreadShell } from "../../state/entities";
import { AssistantAvatar } from "./assistantPresentation";
import { useAssistantFlows } from "./useAssistantFlows";
import { useUsageLimitLabel } from "./useUsageLimitLabel";

/** The face of the assistant that launched this thread, in the mood of the work; tap opens it, and its menu dismisses or restores the task. */
export function AssistantTaskChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const owner = useTaskAssistant(environmentId, threadId);
  const shell = useThreadShell(owner === null ? null : scopeThreadRef(environmentId, threadId));
  const task = useAssistantTask(environmentId, threadId);
  const flows = useAssistantFlows(environmentId);
  const limitLabel = useUsageLimitLabel();
  if (owner === null) return null;
  const state = shell === null ? "running" : assistantTaskState(shell);
  const stateLabel =
    (state === "usage_limited" ? limitLabel(shell?.runtime?.usageLimitResetAt) : null) ??
    ASSISTANT_TASK_STATE_LABEL[state];
  const label = `Task of ${owner.assistant.name}, ${stateLabel.toLowerCase()}`;
  const dismissed = task?.dismissedAt != null;
  const actions: MenuAction[] = [
    {
      id: "open",
      title: `Open ${owner.assistant.name}`,
      image: "bubble.left",
      attributes: { disabled: owner.assistant.threadId === null },
    },
    dismissed
      ? {
          id: "restore",
          title: "Restore task",
          image: "arrow.uturn.backward",
          attributes: { disabled: !flows.canAct },
        }
      : {
          id: "dismiss",
          title: "Dismiss task",
          image: "xmark",
          attributes: { disabled: !flows.canAct || !canDismissAssistantTask(state) },
        },
  ];
  return (
    <View className="flex-row px-4 py-1">
      <Menu
        actions={actions}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "open") flows.openConversation(owner.assistant);
          else if (nativeEvent.event === "restore") void flows.restoreTask(threadId);
          else void flows.dismissTask(threadId);
        }}
      >
        <Pressable
          testID="assistant-task-chip"
          accessibilityRole="button"
          accessibilityLabel={label}
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
      </Menu>
    </View>
  );
}
