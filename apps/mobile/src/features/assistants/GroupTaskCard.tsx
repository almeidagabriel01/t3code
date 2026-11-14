import { assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_GROUP_STATUS_LABEL,
  assistantGroupTaskReasonLabel,
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

export type GroupStatusTone = "quiet" | "active" | "attention" | "done" | "failed";

// Text on the canvas or a card in both themes; the `-foreground` status tokens sit on their fills.
const TONE_CLASSES: Record<GroupStatusTone, { readonly dot: string; readonly text: string }> = {
  quiet: { dot: "bg-foreground-muted", text: "text-foreground-muted" },
  active: { dot: "bg-adaptive-sky-600-400", text: "text-adaptive-sky-700-300" },
  attention: { dot: "bg-adaptive-amber-700-400", text: "text-adaptive-amber-700-300" },
  done: { dot: "bg-adaptive-emerald-600-400", text: "text-adaptive-emerald-700-300" },
  failed: { dot: "bg-adaptive-rose-600-400", text: "text-adaptive-rose-700-300" },
};

/** A status as a coloured dot and its label. */
export function GroupStatusLabel(props: {
  readonly tone: GroupStatusTone;
  readonly label: string;
  readonly testID?: string;
}) {
  const tone = TONE_CLASSES[props.tone];
  return (
    <View className="flex-row items-center gap-1.5">
      <View className={cn("size-1.5 rounded-full", tone.dot)} />
      <Text testID={props.testID} className={cn("text-xs font-t3-medium", tone.text)}>
        {props.label}
      </Text>
    </View>
  );
}

const STATUS_TONE: Record<AssistantGroupTask["status"], GroupStatusTone> = {
  queued: "quiet",
  running: "active",
  waiting: "attention",
  completed: "done",
  paused: "attention",
  cancelled: "quiet",
  failed: "failed",
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
  const waiting = assistantGroupWaitingReason(task);
  const reasonLabel = assistantGroupTaskReasonLabel(task);
  return (
    <View
      testID="group-task-card"
      className="mt-2 gap-2 self-stretch rounded-2xl border border-foreground/10 bg-foreground/3 px-3 py-2.5"
    >
      <View className="flex-row items-center gap-2">
        <GroupStatusLabel
          testID="group-task-status"
          tone={STATUS_TONE[task.status]}
          label={ASSISTANT_GROUP_STATUS_LABEL[task.status]}
        />
        {props.ownerName === undefined ? null : (
          <Text
            className="shrink text-xs font-t3-medium text-foreground-secondary"
            numberOfLines={1}
          >
            {props.ownerName}
          </Text>
        )}
      </View>
      <Text className="text-sm text-foreground" numberOfLines={3}>
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
            <View key={resource} className="rounded-full bg-foreground/6 px-2 py-0.5">
              <Text className="text-[11px] text-foreground-muted">{resource}</Text>
            </View>
          ))}
        </View>
      )}
      {waiting === null ? null : (
        <Text testID="group-task-waiting" className="text-xs text-adaptive-amber-700-300">
          {waiting}
        </Text>
      )}
      {needs === null ? null : (
        <Text
          testID="group-task-needs"
          className="text-xs font-t3-bold text-adaptive-amber-700-300"
        >
          {needs} · Open the conversation to answer
        </Text>
      )}
      {reasonLabel === null ? null : (
        <Text className="text-xs text-foreground-muted">{reasonLabel}</Text>
      )}
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
