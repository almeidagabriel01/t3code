import { assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_GROUP_STATUS_LABEL,
  assistantGroupPauseReasonLabel,
  assistantGroupWaitingReason,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  assistantGroupTaskActions,
  type Assistant,
  type AssistantGroupTask,
  type AssistantGroupTaskAction,
  type EnvironmentId,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import { useUsageLimitLabel } from "./useUsageLimitLabel";

const STATUS_TONE: Record<AssistantGroupTask["status"], string> = {
  queued: "text-foreground-muted",
  running: "text-primary-text",
  waiting: "text-warning-foreground",
  usage_limited: "text-warning-foreground",
  completed: "text-success-foreground",
  paused: "text-warning-foreground",
  cancelled: "text-foreground-muted",
  failed: "text-danger-foreground",
};

const ACTION_LABEL: Record<Exclude<AssistantGroupTaskAction, "reassign">, string> = {
  stop: "Stop",
  resume: "Resume",
  cancel: "Cancel",
};

/** One task of a request: its state, what was asked, and what the user can do with it. */
export function GroupTaskCard(props: {
  readonly task: AssistantGroupTask;
  readonly environmentId: EnvironmentId;
  /** Shown when the card is not under its owner's own message. */
  readonly ownerName?: string | undefined;
  /** Active members that can take the task over, without its owner. */
  readonly reassignTo: ReadonlyArray<Assistant>;
  readonly canAct: boolean;
  readonly onAction: (action: AssistantGroupTaskAction, ownerId?: Assistant["id"]) => void;
  readonly onOpenConversation: () => void;
}) {
  const { task } = props;
  // A running member that waits on an approval or a question is answered in its own thread.
  const shell = useThreadShell(
    task.status === "running" ? scopeThreadRef(props.environmentId, task.threadId) : null,
  );
  const presence = shell === null ? null : assistantPresence(shell);
  const needs = presence?.mood === "needs" ? presence.detail : null;
  const limitLabel = useUsageLimitLabel();
  const waiting =
    task.status === "usage_limited" ? limitLabel(task.resetAt) : assistantGroupWaitingReason(task);
  return (
    <View
      testID="group-task-card"
      className="mt-1.5 gap-1.5 self-stretch rounded-xl border border-border px-3 py-2"
    >
      <View className="flex-row items-center gap-2">
        <Text
          testID="group-task-status"
          className={cn("text-xs font-t3-bold", STATUS_TONE[task.status])}
        >
          {ASSISTANT_GROUP_STATUS_LABEL[task.status]}
        </Text>
        {props.ownerName === undefined ? null : (
          <Text className="text-xs font-t3-bold text-foreground">{props.ownerName}</Text>
        )}
      </View>
      <Text className="text-xs text-foreground" numberOfLines={2}>
        {task.instruction}
      </Text>
      {task.expectedResult === undefined ? null : (
        <Text
          testID="group-task-expected"
          className="text-xs text-foreground-muted"
          numberOfLines={2}
        >
          Expected: {task.expectedResult}
        </Text>
      )}
      {task.resources === undefined ? null : (
        <View testID="group-task-resources" className="flex-row flex-wrap gap-1">
          {task.resources.map((resource) => (
            <View key={resource} className="rounded-full border border-border px-2 py-0.5">
              <Text className="text-[11px] text-foreground-muted">{resource}</Text>
            </View>
          ))}
        </View>
      )}
      {waiting === null ? null : (
        <Text testID="group-task-waiting" className="text-xs text-warning-foreground">
          {waiting}
        </Text>
      )}
      {needs === null ? null : (
        <Text testID="group-task-needs" className="text-xs font-t3-bold text-warning-foreground">
          {needs} · Open the conversation to answer
        </Text>
      )}
      {task.status === "paused" ? (
        <Text className="text-xs text-foreground-muted">
          {assistantGroupPauseReasonLabel(task.reason)}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap items-center gap-1.5">
        {assistantGroupTaskActions(task).map((action) =>
          action === "reassign" ? (
            <Menu
              key={action}
              actions={props.reassignTo.map((member) => ({
                id: member.id,
                title: member.name,
                attributes: { disabled: !props.canAct },
              }))}
              onPressAction={({ nativeEvent }) =>
                props.onAction("reassign", nativeEvent.event as Assistant["id"])
              }
            >
              <Button
                label="Reassign"
                size="compact"
                disabled={!props.canAct || props.reassignTo.length === 0}
                onPress={() => undefined}
              />
            </Menu>
          ) : (
            <Button
              key={action}
              label={ACTION_LABEL[action]}
              size="compact"
              disabled={!props.canAct}
              onPress={() => props.onAction(action)}
            />
          ),
        )}
        <Button
          label="Open conversation"
          icon="bubble.left"
          tone="text"
          size="compact"
          onPress={props.onOpenConversation}
        />
      </View>
    </View>
  );
}
