import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAssistantEntries, type AssistantEntry } from "../../state/assistants";
import { useProjects } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AssistantAvatar, toolAccessLabel } from "./assistantPresentation";
import { useOpenAssistantEditor } from "./openAssistantEditor";

function AssistantListRow(props: { readonly entry: AssistantEntry; readonly detail: string[] }) {
  const { assistant, environmentId } = props.entry;
  const openEditor = useOpenAssistantEditor();
  const project = useProjects().find(
    (candidate) =>
      candidate.environmentId === environmentId && candidate.id === assistant.projectId,
  );
  const detail = [
    `@${assistant.handle}`,
    toolAccessLabel(assistant.toolAccess),
    project ? (project.isScratch === true ? "No project" : project.title) : null,
    ...props.detail,
  ].filter((part): part is string => part !== null);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`${assistant.name}, ${detail.join(", ")}`}
      onPress={() => openEditor(environmentId, assistant)}
      className="bg-grouped-card"
    >
      <View className="min-h-16 flex-row items-center gap-3 px-4 py-3">
        <AssistantAvatar assistant={assistant} size={32} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" className="text-foreground" numberOfLines={1}>
            {assistant.name}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {detail.join(" · ")}
          </Text>
        </View>
      </View>
    </RowPressable>
  );
}

export function SettingsAssistantsRouteScreen() {
  const { active, archived } = useAssistantEntries();
  const insets = useSafeAreaInsets();
  const openEditor = useOpenAssistantEditor();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = new Set([...active, ...archived].map((entry) => entry.environmentId))
    .size;
  const detailFor = (entry: AssistantEntry) =>
    environmentCount > 1 && savedConnectionsById[entry.environmentId]
      ? [savedConnectionsById[entry.environmentId]!.environmentLabel]
      : [];
  const firstEnvironmentId = active[0]?.environmentId ?? archived[0]?.environmentId ?? null;
  return (
    <SettingsScreen
      title="Assistants"
      actions={
        firstEnvironmentId === null
          ? []
          : [
              {
                accessibilityLabel: "New assistant",
                icon: "person.badge.plus",
                onPress: () => openEditor(firstEnvironmentId, null),
              },
            ]
      }
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {active.length === 0 && archived.length === 0 ? (
          <EmptyState
            variant="plain"
            title="No assistants"
            detail="Connect an environment that supports assistants to see and create them."
          />
        ) : (
          <>
            <ListSection
              title="Assistants"
              footer="Each assistant keeps one long conversation you can come back to."
            >
              {active.map((entry) => (
                <AssistantListRow
                  key={`${entry.environmentId}:${entry.assistant.id}`}
                  entry={entry}
                  detail={detailFor(entry)}
                />
              ))}
            </ListSection>
            {archived.length > 0 ? (
              <ListSection title="Archived">
                {archived.map((entry) => (
                  <AssistantListRow
                    key={`${entry.environmentId}:${entry.assistant.id}`}
                    entry={entry}
                    detail={detailFor(entry)}
                  />
                ))}
              </ListSection>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
