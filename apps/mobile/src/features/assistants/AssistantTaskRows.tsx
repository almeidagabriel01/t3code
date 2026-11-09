import {
  ASSISTANT_TASK_FACE,
  ASSISTANT_TASK_STATE_LABEL,
  assistantTaskRows,
  type AssistantTaskState,
} from "@t3tools/client-runtime/assistantTasks";
import type { AssistantMood } from "@t3tools/client-runtime/assistantRobot";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useAssistantTasks, type AssistantEntry } from "../../state/assistants";
import { useQuietThreadShells } from "../../state/entities";
import { AssistantAvatar } from "./assistantPresentation";
import { moodTextClass } from "./assistantPresenceLabels";
import { useAssistantFlows } from "./useAssistantFlows";

const MOOD_OF_STATE: Record<AssistantTaskState, AssistantMood> = {
  running: "working",
  waiting: "needs",
  failed: "failed",
  done: "idle",
};

/** Finished tasks fade out of the list; open and failed ones stay until the thread is gone. */
const MAX_DONE = 2;

/**
 * The threads an assistant launched, one line each: its face in the task's mood, the title and
 * the state. Tapping opens the thread. Nothing renders while it has none.
 */
export function AssistantTaskRows(props: {
  readonly entry: AssistantEntry;
  readonly sidebar?: boolean;
}) {
  const { assistant, environmentId } = props.entry;
  const tasks = useAssistantTasks(environmentId, assistant.id);
  const shells = useQuietThreadShells();
  const flows = useAssistantFlows(environmentId);
  const rows = useMemo(() => {
    if (tasks.length === 0) return [];
    const byId = new Map(
      shells.filter((shell) => shell.environmentId === environmentId).map((s) => [s.id, s]),
    );
    let done = 0;
    return assistantTaskRows(tasks, (threadId) => byId.get(threadId as never)).filter((row) =>
      row.state !== "done" ? true : ++done <= MAX_DONE,
    );
  }, [tasks, shells, environmentId]);
  if (rows.length === 0) return null;
  return (
    <View testID="assistant-task-list" className="ml-3.5 border-l border-border pl-1">
      {rows.map(({ task, shell, state }) => (
        <Pressable
          key={task.threadId}
          testID="assistant-task-row"
          accessibilityRole="button"
          accessibilityLabel={`${shell.title}, ${ASSISTANT_TASK_STATE_LABEL[state]}`}
          onPress={() => flows.openConversation({ threadId: task.threadId })}
          className="min-h-10 flex-row items-center gap-2 rounded-2xl px-2 active:opacity-70"
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
      ))}
    </View>
  );
}
