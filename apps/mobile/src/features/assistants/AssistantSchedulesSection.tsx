import { useNavigation } from "@react-navigation/native";
import type { Assistant, EnvironmentId, ModelSelection, ScheduledTask } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { startScheduledTaskEditor } from "../settings/scheduled-task-editor-state";
import { describeSchedule } from "../settings/scheduledTaskPresentation";
import { createDraft, editDraft } from "../settings/scheduledTaskDraft";

/** The scheduled tasks that run in the assistant's current conversation. */
export function AssistantSchedulesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly assistant: Assistant;
  readonly modelSelection: ModelSelection | null;
}) {
  const { environmentId, environmentLabel, assistant } = props;
  const navigation = useNavigation();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
    reportFailure: true,
  });
  const bound =
    tasks.data?.tasks.filter((task: ScheduledTask) => task.threadId === assistant.threadId) ?? [];
  const open = (draft: ReturnType<typeof createDraft>, route: "New" | "Edit") => {
    startScheduledTaskEditor({ environmentId, environmentLabel, draft });
    navigation.navigate(`SettingsScheduledTask${route}`);
  };
  return (
    <View className="gap-2">
      <View className="gap-0.5 px-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          Schedules
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          Tasks that run in its current conversation. A reset keeps them attached.
        </Text>
      </View>
      <ListSection>
        {bound.map((task) => (
          <View key={task.id} className="flex-row items-center bg-grouped-card">
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${task.title}`}
              onPress={() => open(editDraft(task), "Edit")}
              className="min-w-0 flex-1 bg-grouped-card"
            >
              <ListRowLayout
                icon="calendar.badge.clock"
                label={task.title}
                description={`${describeSchedule(task)}${task.enabled ? "" : " · Paused"}`}
              />
            </RowPressable>
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
        <ListActionRow
          icon="plus"
          label="New schedule"
          disabled={assistant.threadId === null}
          onPress={() =>
            open(createDraft(assistant.projectId, props.modelSelection, assistant.threadId), "New")
          }
        />
      </ListSection>
    </View>
  );
}
