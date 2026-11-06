import { teamSubtitle, teamSummary } from "@t3tools/client-runtime/assistantTeam";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  useAssistantEntries,
  useAssistantSpend,
  useAssistantsEnvironmentIds,
  type AssistantEntry,
  type AssistantTeamEntry,
} from "../../state/assistants";
import { useProjects } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AutonomySettingsSection } from "./AutonomySettingsSection";
import { AssistantAvatar, toolAccessLabel } from "./assistantPresentation";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useAssistantFlows } from "./useAssistantFlows";

function AssistantListRow(props: { readonly entry: AssistantEntry; readonly detail: string[] }) {
  const { assistant, environmentId } = props.entry;
  const openEditor = useOpenAssistantEditor();
  const project = useProjects().find(
    (candidate) =>
      candidate.environmentId === environmentId && candidate.id === assistant.projectId,
  );
  const budgetState = useAssistantSpend(environmentId, assistant.budget ? assistant.id : null).data
    ?.budget?.state;
  const detail = [
    `@${assistant.handle}`,
    // Role and leader first: the line truncates at the end on a phone.
    ...props.detail,
    toolAccessLabel(assistant.toolAccess),
    project ? (project.isScratch === true ? "No project" : project.title) : null,
    budgetState === "exceeded" ? "Limit reached" : budgetState === "warn" ? "Near limit" : null,
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

function TeamListRow(props: {
  readonly entry: AssistantTeamEntry;
  readonly assistants: ReadonlyArray<AssistantEntry["assistant"]>;
}) {
  const openTeam = useOpenAssistantTeam();
  const { team, environmentId } = props.entry;
  const summary = teamSummary(team, props.assistants);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`${team.name}, ${summary}`}
      onPress={() => openTeam.activity(environmentId, team.id)}
      className="bg-grouped-card"
    >
      <View className="min-h-16 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" className="text-foreground" numberOfLines={1}>
            {team.name}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {summary}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${team.name}`}
          hitSlop={8}
          onPress={() => openTeam.edit(environmentId, team.id)}
          className="active:opacity-70"
        >
          <SymbolView
            name="pencil"
            size={16}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </Pressable>
      </View>
    </RowPressable>
  );
}

function RestoreJarvisRow(props: { readonly environmentId: EnvironmentId }) {
  const flows = useAssistantFlows(props.environmentId);
  return (
    <ListActionRow
      icon="arrow.uturn.backward"
      label="Restore Jarvis"
      description="The default assistant was deleted. Brings him back."
      disabled={!flows.canAct}
      onPress={() => void flows.restoreDefault()}
    />
  );
}

export function SettingsAssistantsRouteScreen() {
  const { active, archived, teams, environmentIds: loadedEnvironmentIds } = useAssistantEntries();
  const openTeam = useOpenAssistantTeam();
  const insets = useSafeAreaInsets();
  const openEditor = useOpenAssistantEditor();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = loadedEnvironmentIds.length;
  const teamOf = (entry: AssistantEntry) =>
    teamSubtitle(
      entry.assistant,
      [...active, ...archived]
        .filter((other) => other.environmentId === entry.environmentId)
        .map((other) => other.assistant),
    );
  const detailFor = (entry: AssistantEntry) => [
    ...(teamOf(entry) === null ? [] : [teamOf(entry)!]),
    ...(environmentCount > 1 && savedConnectionsById[entry.environmentId]
      ? [savedConnectionsById[entry.environmentId]!.environmentLabel]
      : []),
  ];
  const environmentIds = useAssistantsEnvironmentIds();
  const firstEnvironmentId = loadedEnvironmentIds[0] ?? null;
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
        {loadedEnvironmentIds.length === 0 ? (
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
              {loadedEnvironmentIds
                .filter(
                  (environmentId) =>
                    ![...active, ...archived].some(
                      (entry) => entry.environmentId === environmentId && entry.assistant.isDefault,
                    ),
                )
                .map((environmentId) => (
                  <RestoreJarvisRow key={environmentId} environmentId={environmentId} />
                ))}
            </ListSection>
            <ListSection
              title="Teams"
              footer="Members of a team message each other and you can read what they say. Tap a team for its activity."
            >
              {teams.map((entry) => (
                <TeamListRow
                  key={`${entry.environmentId}:${entry.team.id}`}
                  entry={entry}
                  assistants={[...active, ...archived]
                    .filter((other) => other.environmentId === entry.environmentId)
                    .map((other) => other.assistant)}
                />
              ))}
              {active.length >= 2 ? (
                <ListActionRow
                  icon="person.2"
                  label="New team"
                  description="Group assistants so they can talk to each other."
                  onPress={() => openTeam.edit(firstEnvironmentId!, null)}
                />
              ) : null}
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
            {environmentIds.map((environmentId) => (
              <AutonomySettingsSection
                key={environmentId}
                environmentId={environmentId}
                suffix={
                  environmentIds.length > 1
                    ? ` · ${savedConnectionsById[environmentId]?.environmentLabel ?? environmentId}`
                    : ""
                }
              />
            ))}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
