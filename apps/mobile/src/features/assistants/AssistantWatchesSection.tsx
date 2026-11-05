import { useNavigation } from "@react-navigation/native";
import {
  EMPTY_WATCH_DRAFT,
  watchDraftFromWatch,
  watchSummary,
} from "@t3tools/client-runtime/autonomy";
import type { AssistantId, AutonomyWatch, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { relativeTime } from "../../lib/time";
import { useAutonomyWatchActions, useAutonomyWatches } from "../../state/autonomy";
import { startAssistantWatchEditor } from "./assistantWatchEditor";

/** The watches that wake this assistant, next to its schedules. */
export function AssistantWatchesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly assistantId: AssistantId;
  readonly notifies: boolean;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly label: string }>;
}) {
  const { environmentId, assistantId, projects } = props;
  const navigation = useNavigation();
  const query = useAutonomyWatches(environmentId);
  const actions = useAutonomyWatchActions(environmentId);
  const watches = (query.data?.watches ?? []).filter(
    (watch) => (watch.assistantId as string) === assistantId,
  );
  const projectTitle = (id: ProjectId) =>
    projects.find((project) => project.id === id)?.label ?? null;
  const open = (draft: typeof EMPTY_WATCH_DRAFT) => {
    startAssistantWatchEditor({ environmentId, assistantId, projects, draft });
    navigation.navigate("SettingsAssistantWatch");
  };
  const toggle = async (watch: AutonomyWatch, enabled: boolean) => {
    const reply = await actions.setEnabled(watch.id, enabled);
    if (!reply.ok) Dialog.alert("Could not update the watch", reply.message);
  };
  return (
    <View className="gap-2">
      <View className="gap-0.5 px-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          Watches
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          Wake this assistant when something happens, e.g. CI fails on a PR.
          {props.notifies ? "" : " Watches only wake it when its notifications are on."}
        </Text>
      </View>
      {query.error !== null ? (
        <Text textRole="footnote" className="px-2 text-danger-foreground">
          Could not load watches: {query.error}
        </Text>
      ) : null}
      <ListSection>
        {watches.map((watch) => (
          <View key={watch.id} className="flex-row items-center bg-grouped-card">
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${watch.title}`}
              disabled={!actions.canAct}
              onPress={() => open(watchDraftFromWatch(watch))}
              className="min-w-0 flex-1 bg-grouped-card"
            >
              <ListRowLayout
                icon="eye"
                label={watch.title}
                description={`${watchSummary(watch, projectTitle)} · ${
                  watch.lastTriggeredAt === null
                    ? "Never triggered"
                    : `Last triggered ${relativeTime(watch.lastTriggeredAt)} ago`
                }${watch.enabled ? "" : " · Paused"}`}
              />
            </RowPressable>
            <View className="pr-4">
              <ThemedSwitch
                accessibilityLabel={`${watch.title} enabled`}
                disabled={!actions.canAct}
                value={watch.enabled}
                onValueChange={(enabled) => void toggle(watch, enabled)}
              />
            </View>
          </View>
        ))}
        <ListActionRow
          icon="plus"
          label="New watch"
          description={
            watches.length === 0 && query.error === null
              ? "No watches yet. A watch wakes this assistant when an event you pick happens."
              : undefined
          }
          disabled={!actions.canAct}
          onPress={() => open(EMPTY_WATCH_DRAFT)}
        />
      </ListSection>
    </View>
  );
}
