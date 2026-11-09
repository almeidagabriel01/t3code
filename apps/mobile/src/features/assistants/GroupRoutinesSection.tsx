import { useNavigation } from "@react-navigation/native";
import { formatNextRun } from "@t3tools/client-runtime/assistantWork";
import type { AssistantTeamId, EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { startScheduledTaskEditor } from "../settings/scheduled-task-editor-state";
import { editDraft } from "../settings/scheduledTaskDraft";
import { describeSchedule } from "../settings/scheduledTaskPresentation";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import { useScheduleInGroup } from "./useScheduleInGroup";

/** What a routine row says: its schedule, when it runs next in local time, and how the last run went. */
export function groupRoutineDescription(task: ScheduledTask, nowMs: number): string {
  const reached = task.maxRuns != null && task.runCount >= task.maxRuns;
  return [
    describeSchedule(task),
    !task.enabled
      ? reached
        ? "Stopped at its run limit"
        : "Paused"
      : task.nextRunAt === null
        ? "Not scheduled"
        : `Next ${formatNextRun(task.nextRunAt, nowMs)}`,
    task.maxRuns == null ? null : `${task.runCount} of ${task.maxRuns} runs`,
    task.schedule.type === "fixed_time" && task.missedRunPolicy === "once"
      ? "Catches up once if missed"
      : null,
    task.lastRunStatus === "failed"
      ? `Last run failed${task.lastRunError ? `: ${task.lastRunError}` : ""}`
      : task.lastRunStatus === "succeeded"
        ? "Last run posted"
        : null,
  ]
    .filter((line) => line !== null && line !== "")
    .join("\n");
}

/** The routines that post in one group's chat, with the controls to run, pause, edit and delete them. */
export function GroupRoutinesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly teamId: AssistantTeamId;
}) {
  const { environmentId, teamId } = props;
  const navigation = useNavigation();
  const scheduleInGroup = useScheduleInGroup();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const nowMs = useNowMinuteMs();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
    reportFailure: true,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
    reportFailure: true,
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
    reportFailure: true,
  });
  const routines =
    tasks.data?.tasks.filter((task: ScheduledTask) => task.assistantTeamId === teamId) ?? [];
  const edit = (task: ScheduledTask) => {
    startScheduledTaskEditor({
      environmentId,
      environmentLabel:
        availableTargets.find((target) => target.environmentId === environmentId)?.label ?? "",
      draft: editDraft(task),
    });
    navigation.navigate("SettingsScheduledTaskEdit");
  };
  return (
    <ListSection
      title="Routines"
      footer="Each run posts its request in the group chat, as if you had written it."
    >
      {routines.map((task) => (
        <View key={task.id} className="flex-row items-center bg-grouped-card">
          <RowPressable
            accessibilityRole="button"
            accessibilityLabel={`Edit ${task.title}`}
            onPress={() => edit(task)}
            className="min-w-0 flex-1 bg-grouped-card"
          >
            <ListRowLayout
              icon="calendar.badge.clock"
              label={task.title}
              description={groupRoutineDescription(task, nowMs)}
            />
          </RowPressable>
          <IconButton
            accessibilityLabel={`Run ${task.title} now`}
            icon="play"
            disabled={task.lastRunStatus === "running"}
            onPress={() => void runNow({ environmentId, input: { id: task.id } })}
          />
          <IconButton
            accessibilityLabel={`Delete ${task.title}`}
            icon="trash"
            onPress={() =>
              Dialog.confirm({
                title: `Delete the routine ${task.title}?`,
                confirmText: "Delete",
                destructive: true,
                onConfirm: () => void remove({ environmentId, input: { id: task.id } }),
              })
            }
          />
          <View className="pr-4">
            <ThemedSwitch
              accessibilityLabel={`${task.title} enabled`}
              value={task.enabled}
              onValueChange={(enabled) =>
                void setEnabled({ environmentId, input: { id: task.id, enabled } })
              }
            />
          </View>
        </View>
      ))}
      {routines.length === 0 ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          No routines in this group yet.
        </Text>
      ) : null}
      <ListActionRow
        icon="plus"
        label="New routine"
        onPress={() => scheduleInGroup(environmentId, teamId)}
      />
    </ListSection>
  );
}
