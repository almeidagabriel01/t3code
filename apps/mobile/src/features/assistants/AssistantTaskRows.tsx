import {
  ASSISTANT_TASK_FACE,
  ASSISTANT_TASK_STATE_LABEL,
  assistantTaskRows,
  canDismissAssistantTask,
  type AssistantTaskRow,
  type AssistantTaskSections,
  type AssistantTaskState,
} from "@t3tools/client-runtime/assistantTasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { AssistantMood } from "@t3tools/client-runtime/assistantRobot";
import type { MenuAction } from "@react-native-menu/menu";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useNowMinuteMs } from "../../lib/clock";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useAssistantTasks, type AssistantEntry } from "../../state/assistants";
import { useQuietThreadShells } from "../../state/entities";
import { AssistantAvatar } from "./assistantPresentation";
import { moodTextClass } from "./assistantPresenceLabels";
import { useAssistantFlows } from "./useAssistantFlows";
import { sortActiveThreadsForRows } from "../threads/threadListV2";
import {
  ThreadListV2SettledShelfHeader,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";

const MOOD_OF_STATE: Record<AssistantTaskState, AssistantMood> = {
  running: "working",
  waiting: "needs",
  failed: "failed",
  done: "idle",
};

const DISMISS_ACTIONS = (canAct: boolean): MenuAction[] => [
  { id: "dismiss", title: "Dismiss task", image: "xmark", attributes: { disabled: !canAct } },
];

const NO_SECTIONS: AssistantTaskSections<EnvironmentThreadShell> = {
  pinned: [],
  open: [],
  snoozed: [],
  settled: [],
};

/** The assistant's task threads split and ordered exactly as the thread list orders a project's. */
export function useAssistantTaskSections(
  entry: AssistantEntry,
): AssistantTaskSections<EnvironmentThreadShell> {
  const { assistant, environmentId } = entry;
  const tasks = useAssistantTasks(environmentId, assistant.id);
  const shells = useQuietThreadShells();
  const { threadOrder } = useThreadListV2ShelfPreferences();
  const nowMs = useNowMinuteMs();
  return useMemo(() => {
    if (tasks.length === 0) return NO_SECTIONS;
    const byId = new Map(
      shells.filter((shell) => shell.environmentId === environmentId).map((s) => [s.id, s]),
    );
    return assistantTaskRows(
      tasks,
      (threadId) => byId.get(threadId as never),
      (open) => sortActiveThreadsForRows(open, threadOrder),
      { now: new Date(nowMs).toISOString() },
    );
  }, [tasks, shells, environmentId, threadOrder, nowMs]);
}

/**
 * The threads an assistant launched, one line each: its face in the task's mood, the title and
 * the state. Settled ones fold into a Settled shelf, as in the thread list. Nothing renders while
 * it has none.
 */
export function AssistantTaskRows(props: {
  readonly entry: AssistantEntry;
  readonly sections: AssistantTaskSections<EnvironmentThreadShell>;
  readonly sidebar?: boolean;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const [settledExpanded, setSettledExpanded] = useState(false);
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  const { pinned, open, snoozed, settled } = props.sections;
  if (pinned.length + open.length + snoozed.length + settled.length === 0) return null;
  const renderRow = ({ task, shell, state }: AssistantTaskRow<EnvironmentThreadShell>) => (
    <View key={task.threadId} className="flex-row items-center">
      <Pressable
        testID="assistant-task-row"
        accessibilityRole="button"
        accessibilityLabel={`${shell.title}, ${ASSISTANT_TASK_STATE_LABEL[state]}`}
        onPress={() => flows.openConversation({ threadId: task.threadId })}
        className="min-h-10 min-w-0 flex-1 flex-row items-center gap-2 rounded-2xl px-2 active:opacity-70"
      >
        <AssistantAvatar
          assistant={assistant}
          environmentId={environmentId}
          mood={ASSISTANT_TASK_FACE[state]}
          size={18}
        />
        <Text
          className={cn(
            "min-w-0 flex-1 text-sm",
            props.sidebar ? "text-drawer-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {shell.title}
        </Text>
        <Text
          className={cn("shrink-0 text-xs", moodTextClass(MOOD_OF_STATE[state], props.sidebar))}
        >
          {ASSISTANT_TASK_STATE_LABEL[state]}
        </Text>
      </Pressable>
      {canDismissAssistantTask(state) ? (
        <Menu
          actions={DISMISS_ACTIONS(flows.canAct)}
          onPressAction={() => void flows.dismissTask(task.threadId)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${shell.title} actions`}
            hitSlop={6}
            className="size-9 items-center justify-center rounded-full active:opacity-70"
          >
            <SymbolView
              name="ellipsis"
              size={16}
              tintColorClassName={
                props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"
              }
              type="monochrome"
            />
          </Pressable>
        </Menu>
      ) : null}
    </View>
  );
  return (
    <View testID="assistant-task-list" className="ml-3.5 border-l border-border pl-1">
      {pinned.map(renderRow)}
      {open.map(renderRow)}
      {snoozed.length === 0 ? null : (
        <ThreadListV2SnoozedShelfHeader
          count={snoozed.length}
          expanded={snoozedExpanded}
          onToggle={() => setSnoozedExpanded((value) => !value)}
          {...(props.sidebar ? { pane: "sidebar" as const } : {})}
        />
      )}
      {snoozedExpanded ? snoozed.map(renderRow) : null}
      {settled.length === 0 ? null : (
        <ThreadListV2SettledShelfHeader
          count={settled.length}
          expanded={settledExpanded}
          onToggle={() => setSettledExpanded((value) => !value)}
          pane={props.sidebar ? "sidebar" : "screen"}
        />
      )}
      {settledExpanded ? settled.map(renderRow) : null}
    </View>
  );
}
