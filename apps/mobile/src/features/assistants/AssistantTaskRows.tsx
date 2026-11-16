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
import type { AssistantTask } from "@t3tools/contracts";
import { useAtom } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { Atom } from "effect/reactivity";
import { useMemo, type ReactNode } from "react";
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
import {
  buildThreadListV2ListItems,
  sortActiveThreadsForRows,
  type ThreadListV2ThreadListItem,
} from "../threads/threadListV2";
import { SwipeRowActivationContext } from "../home/swipe-row-activation";
import {
  ThreadListV2SettledShelfHeader,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import { useUsageLimitLabel } from "./useUsageLimitLabel";

const MOOD_OF_STATE: Record<AssistantTaskState, AssistantMood> = {
  running: "working",
  waiting: "needs",
  usage_limited: "limited",
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
export function assistantTaskSectionsOf(
  tasks: ReadonlyArray<AssistantTask>,
  shellOf: (threadId: string) => EnvironmentThreadShell | undefined,
  threadOrder: Parameters<typeof sortActiveThreadsForRows>[1],
  nowMs: number,
): AssistantTaskSections<EnvironmentThreadShell> {
  if (tasks.length === 0) return NO_SECTIONS;
  return assistantTaskRows(tasks, shellOf, (open) => sortActiveThreadsForRows(open, threadOrder), {
    now: new Date(nowMs).toISOString(),
  });
}

export function useAssistantTaskSections(
  entry: AssistantEntry,
): AssistantTaskSections<EnvironmentThreadShell> {
  const { assistant, environmentId } = entry;
  const tasks = useAssistantTasks(environmentId, assistant.id);
  const shells = useQuietThreadShells();
  const { threadOrder } = useThreadListV2ShelfPreferences();
  const nowMs = useNowMinuteMs();
  return useMemo(() => {
    const byId = new Map(
      shells.filter((shell) => shell.environmentId === environmentId).map((s) => [s.id, s]),
    );
    return assistantTaskSectionsOf(
      tasks,
      (threadId) => byId.get(threadId as never),
      threadOrder,
      nowMs,
    );
  }, [tasks, shells, environmentId, threadOrder, nowMs]);
}

/** Open groups and task shelves of the assistants section, for the session: rows and ⌘1–9 read it. */
const assistantSectionOpenAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
);

export const assistantShelfKey = (shelf: "snoozed" | "settled", entry: AssistantEntry) =>
  `${shelf}:${entry.environmentId}:${entry.assistant.id}`;

export function useAssistantSectionOpen() {
  const [open, setOpen] = useAtom(assistantSectionOpenAtom);
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return { open, toggle };
}

/** Rows drawn the way the thread list draws a project's, so their menus and swipes match. */
function sectionItems(
  rows: ReadonlyArray<AssistantTaskRow<EnvironmentThreadShell>>,
  shelf: "card" | "snoozed" | "settled",
  nowMs: number,
): ReadonlyArray<ThreadListV2ThreadListItem> {
  return buildThreadListV2ListItems({
    items: rows.map(({ shell }) => ({
      thread: shell,
      variant: shelf === "card" ? "card" : "slim",
      snoozed: shelf === "snoozed",
      pinned: shell.pinnedAt != null,
      wokeAt: null,
      isLast: false,
    })),
    pendingTasks: [],
    snoozeLabelNow: `${new Date(nowMs).toISOString().slice(0, 16)}:00.000Z`,
  }).flatMap((item) => (item.type === "v2-thread" ? [{ ...item, compact: true }] : []));
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
  /** Home's thread list row; without it (Settings) tasks keep the compact face rows. */
  readonly renderThread?: (item: ThreadListV2ThreadListItem) => ReactNode;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const limitLabel = useUsageLimitLabel();
  const nowMs = useNowMinuteMs();
  const shelves = useAssistantSectionOpen();
  const snoozedKey = assistantShelfKey("snoozed", props.entry);
  const settledKey = assistantShelfKey("settled", props.entry);
  const snoozedExpanded = shelves.open.has(snoozedKey);
  const settledExpanded = shelves.open.has(settledKey);
  const { pinned, open, snoozed, settled } = props.sections;
  if (pinned.length + open.length + snoozed.length + settled.length === 0) return null;
  const { renderThread } = props;
  const renderRows = (
    rows: ReadonlyArray<AssistantTaskRow<EnvironmentThreadShell>>,
    shelf: "card" | "snoozed" | "settled",
  ) =>
    renderThread === undefined
      ? rows.map(renderRow)
      : sectionItems(rows, shelf, nowMs).map((item) => (
          <View key={item.key}>{renderThread(item)}</View>
        ));
  const renderRow = ({ task, shell, state }: AssistantTaskRow<EnvironmentThreadShell>) => {
    const label =
      (state === "usage_limited" ? limitLabel(shell.runtime?.usageLimitResetAt) : null) ??
      ASSISTANT_TASK_STATE_LABEL[state];
    return (
      <View key={task.threadId} className="flex-row items-center">
        <Pressable
          testID="assistant-task-row"
          accessibilityRole="button"
          accessibilityLabel={`${shell.title}, ${label}`}
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
            {label}
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
  };
  return (
    // Rows above the list never enter its visible range, so they keep their swipes awake.
    <SwipeRowActivationContext value={null}>
      <View testID="assistant-task-list" className="ml-3.5 border-l border-border pl-1">
        {renderRows(pinned, "card")}
        {renderRows(open, "card")}
        {snoozed.length === 0 ? null : (
          <ThreadListV2SnoozedShelfHeader
            count={snoozed.length}
            expanded={snoozedExpanded}
            onToggle={() => shelves.toggle(snoozedKey)}
            {...(props.sidebar ? { pane: "sidebar" as const } : {})}
          />
        )}
        {snoozedExpanded ? renderRows(snoozed, "snoozed") : null}
        {settled.length === 0 ? null : (
          <ThreadListV2SettledShelfHeader
            count={settled.length}
            expanded={settledExpanded}
            onToggle={() => shelves.toggle(settledKey)}
            pane={props.sidebar ? "sidebar" : "screen"}
          />
        )}
        {settledExpanded ? renderRows(settled, "settled") : null}
      </View>
    </SwipeRowActivationContext>
  );
}
