import { useAtomValue } from "@effect/atom-react";
import {
  agendaEntryDetail,
  localDayStarts,
  scheduledTaskAgenda,
  scheduledTaskColor,
  sortScheduledTasks,
  type AgendaDay,
} from "@t3tools/client-runtime/scheduledTaskAgenda";
import { kanbanColor } from "@t3tools/client-runtime/state/kanbanLogic";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  scheduledTaskThreadMode,
  type EnvironmentId,
  type ProjectId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useLeaveSheet } from "../projectViews/useLeaveSheet";
import { startScheduledTaskEditor } from "./scheduled-task-editor-state";
import { describeSchedule, formatNextScheduledTaskRun } from "./scheduledTaskPresentation";
import { editDraft } from "./scheduledTaskDraft";

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });

function Agenda(props: {
  readonly days: ReadonlyArray<AgendaDay>;
  readonly onOpen: (task: ScheduledTask) => void;
}) {
  return (
    <View className="gap-4">
      {props.days.map((day, index) => (
        <View key={day.start} className="gap-1.5">
          <View className="flex-row items-baseline gap-1.5 px-1">
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              {index === 0 ? "Today" : "Tomorrow"}
            </Text>
            <Text textRole="caption" className="text-foreground-muted">
              {dayFormat.format(day.start)}
            </Text>
          </View>
          {day.entries.length === 0 ? (
            <Text
              textRole="footnote"
              className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-foreground-muted"
            >
              Nothing scheduled
            </Text>
          ) : (
            day.entries.map((entry) => {
              const color = kanbanColor(scheduledTaskColor(entry.task.id));
              const detail = agendaEntryDetail(entry);
              return (
                <Pressable
                  key={`${entry.task.id}:${entry.at}:${entry.past}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${entry.task.title}, ${detail}`}
                  onPress={() => props.onOpen(entry.task)}
                  className="flex-row overflow-hidden rounded-xl active:opacity-70"
                  style={{ backgroundColor: `${color}22`, opacity: entry.past ? 0.7 : 1 }}
                >
                  <View className="w-1" style={{ backgroundColor: color }} />
                  <View className="min-w-0 flex-1 gap-0.5 px-3 py-2">
                    <Text
                      textRole="footnote"
                      numberOfLines={1}
                      className="font-t3-medium text-foreground"
                    >
                      {entry.task.title}
                    </Text>
                    <Text textRole="caption" className="text-foreground-muted">
                      {detail}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )}
        </View>
      ))}
    </View>
  );
}

/** A thread's project schedule: today and tomorrow's runs, then every task with its controls. */
export function ProjectScheduledTasksView(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const leaveSheet = useLeaveSheet();
  const selectDetail = useSelectWorkspaceDetail();
  const now = useNowMinuteMs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run",
    reportFailure: false,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const tasks = sortScheduledTasks(
    query.data?.tasks.filter((task) => task.projectId === projectId) ?? [],
  );
  const days = scheduledTaskAgenda(tasks, now, localDayStarts(now, 2));

  const openTask = (task: ScheduledTask) => {
    startScheduledTaskEditor({
      environmentId,
      environmentLabel: savedConnectionsById[environmentId]?.environmentLabel ?? "This machine",
      draft: editDraft(task),
    });
    leaveSheet("SettingsScheduledTaskEdit");
  };
  const act = async (
    task: ScheduledTask,
    title: string,
    run: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(task.id);
    const result = await run();
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const body = (() => {
    if (query.error) {
      return (
        <EmptyState variant="plain" title="Could not load scheduled tasks" detail={query.error} />
      );
    }
    if (!query.data) {
      return (
        <EmptyState
          variant="plain"
          title="Loading scheduled tasks…"
          detail="Connecting to the environment."
        />
      );
    }
    if (tasks.length === 0) {
      return (
        <EmptyState
          variant="plain"
          title="No scheduled tasks in this project"
          detail="Create one from Manage scheduled tasks."
        />
      );
    }
    return (
      <>
        <Agenda days={days} onOpen={openTask} />
        <View className="gap-1">
          <Text textRole="footnote" className="px-1 font-t3-medium text-foreground-muted">
            Tasks {tasks.length}
          </Text>
          {tasks.map((task) => {
            const nextRun =
              task.enabled && task.nextRunAt
                ? ` · ${formatNextScheduledTaskRun(task.nextRunAt, now)}`
                : "";
            const showThread =
              task.threadId !== null && scheduledTaskThreadMode(task) !== "new_thread";
            return (
              <View key={task.id} className="flex-row items-center gap-1 py-1.5">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${task.title}`}
                  onPress={() => openTask(task)}
                  className="min-w-0 flex-1 flex-row items-center gap-2.5 active:opacity-70"
                >
                  {task.enabled ? (
                    <View
                      className="size-2 rounded-full"
                      style={{ backgroundColor: kanbanColor(scheduledTaskColor(task.id)) }}
                    />
                  ) : (
                    <View className="size-2 rounded-full border border-foreground-muted" />
                  )}
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text textRole="body" numberOfLines={1} className="text-foreground">
                      {task.title}
                    </Text>
                    <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
                      {describeSchedule(task)}
                      {task.enabled ? nextRun : " · Paused"}
                    </Text>
                  </View>
                </Pressable>
                {task.schedule.type === "webhook" ? null : (
                  <IconButton
                    accessibilityLabel={`Run ${task.title} now`}
                    icon="bolt.circle"
                    disabled={!canOperate || busy === task.id || task.lastRunStatus === "running"}
                    onPress={() =>
                      void act(task, "Could not run the task", () =>
                        runNow({ environmentId, input: { id: task.id } }),
                      )
                    }
                  />
                )}
                <IconButton
                  accessibilityLabel={`${task.enabled ? "Pause" : "Resume"} ${task.title}`}
                  icon={task.enabled ? "pause" : "play"}
                  disabled={!canOperate || busy === task.id}
                  onPress={() =>
                    void act(
                      task,
                      task.enabled ? "Could not pause the task" : "Could not resume the task",
                      () =>
                        setEnabled({
                          environmentId,
                          input: { id: task.id, enabled: !task.enabled },
                        }),
                    )
                  }
                />
                <Menu
                  actions={[
                    { id: "open", title: "Open task", image: "arrow.up.right.square" },
                    ...(showThread
                      ? [{ id: "thread", title: "Open thread", image: "text.bubble" }]
                      : []),
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "open") openTask(task);
                    else if (nativeEvent.event === "thread" && task.threadId !== null) {
                      selectDetail({
                        name: "Thread",
                        params: {
                          environmentId: String(environmentId),
                          threadId: String(task.threadId),
                        },
                      });
                    }
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Actions for ${task.title}`}
                    className="size-11 items-center justify-center active:opacity-70"
                  >
                    <SymbolView
                      name="ellipsis"
                      size={18}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  </Pressable>
                </Menu>
              </View>
            );
          })}
        </View>
      </>
    );
  })();

  return <View className="gap-5">{body}</View>;
}
