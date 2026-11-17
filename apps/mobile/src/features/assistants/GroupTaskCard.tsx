import { assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import { foldToggleLabel } from "@t3tools/client-runtime/messageFold";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_GROUP_STATUS_LABEL,
  assistantGroupTaskReasonLabel,
  assistantGroupWaitingOn,
  assistantGroupWaitingOnLabel,
  assistantGroupWaitingReason,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  assistantGroupTaskActions,
  type Assistant,
  type AssistantGroupTask,
  type AssistantGroupTaskAction,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View, type TextLayoutEvent } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useQuietThreadShell, useThreadShell } from "../../state/entities";
import { useUsageLimitLabel } from "./useUsageLimitLabel";

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
  usage_limited: "attention",
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

const INSTRUCTION_LINES = 3;
const EXPECTED_LINES = 2;

/** Lines a text takes unclamped, read from an invisible twin laid out at the same width. */
function useUnclampedLines(text: string | null) {
  const [measured, setMeasured] = useState<{ readonly text: string; readonly count: number }>();
  const onTextLayout = (event: TextLayoutEvent) => {
    const count = event.nativeEvent.lines.length;
    setMeasured((current) =>
      text === null || (current?.text === text && current.count === count)
        ? current
        : { text, count },
    );
  };
  return [measured?.text === text ? measured.count : 0, onTextLayout] as const;
}

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
  readonly onOpenThread: (threadId: ThreadId) => void;
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
  const reasonLabel = assistantGroupTaskReasonLabel(task);
  const expected = task.expectedResult === undefined ? null : `Expected: ${task.expectedResult}`;
  const [expanded, setExpanded] = useState(false);
  const [instructionLines, measureInstruction] = useUnclampedLines(task.instruction);
  const [expectedLines, measureExpected] = useUnclampedLines(expected);
  const clipped = instructionLines > INSTRUCTION_LINES || expectedLines > EXPECTED_LINES;
  const waitingOn = assistantGroupWaitingOn(task);
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
      <View className="gap-2">
        <Text
          aria-hidden
          onTextLayout={measureInstruction}
          className="absolute inset-x-0 -z-[1] text-sm opacity-0"
        >
          {task.instruction}
        </Text>
        {expected === null ? null : (
          <Text
            aria-hidden
            onTextLayout={measureExpected}
            className="absolute inset-x-0 -z-[1] text-xs opacity-0"
          >
            {expected}
          </Text>
        )}
        <Text
          testID="group-task-instruction"
          className="text-sm text-foreground"
          numberOfLines={expanded ? undefined : INSTRUCTION_LINES}
        >
          {task.instruction}
        </Text>
        {expected === null ? null : (
          <Text
            testID="group-task-expected"
            className="text-xs text-foreground-muted"
            numberOfLines={expanded ? undefined : EXPECTED_LINES}
          >
            {expected}
          </Text>
        )}
      </View>
      {clipped ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={foldToggleLabel(expanded)}
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => setExpanded((value) => !value)}
          className="self-start active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            {foldToggleLabel(expanded)}
          </Text>
        </Pressable>
      ) : null}
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
      {waitingOn === null ? null : (
        <View testID="group-task-waiting-threads" className="gap-1">
          <Text className="text-xs text-adaptive-amber-700-300">
            {assistantGroupWaitingOnLabel(waitingOn)}
          </Text>
          <View className="flex-row flex-wrap gap-1.5">
            {(["threads", "subagents"] as const).flatMap((kind) =>
              waitingOn[kind].map((threadId) => (
                <WaitingThreadLink
                  key={`${kind}:${threadId}`}
                  environmentId={props.environmentId}
                  threadId={threadId}
                  onOpen={() => props.onOpenThread(threadId)}
                />
              )),
            )}
          </View>
        </View>
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

function WaitingThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpen: () => void;
}) {
  const title =
    useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId))?.title.trim() ||
    "Untitled thread";
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${title}`}
      onPress={props.onOpen}
      hitSlop={4}
      className="max-w-full rounded-full bg-foreground/6 px-2.5 py-1 active:bg-foreground/12"
    >
      <Text
        testID="group-task-waiting-link"
        className="text-xs font-t3-medium text-foreground"
        numberOfLines={1}
      >
        {title}
      </Text>
    </Pressable>
  );
}
