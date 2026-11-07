import { assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import { assistantEntryKey, assistantSections } from "@t3tools/client-runtime/assistantSections";
import { teamSubtitle } from "@t3tools/client-runtime/assistantTeam";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import {
  useAssistantEntries,
  useAssistantSpend,
  useAssistantsEnvironmentIds,
  type AssistantEntry,
  type AssistantTeamEntry,
} from "../../state/assistants";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AssistantSandboxSection } from "./AssistantSandboxSection";
import { AutonomySettingsSection } from "./AutonomySettingsSection";
import { AssistantAvatar } from "./assistantPresentation";
import { moodTextClass } from "./assistantPresenceLabels";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useAssistantFlows } from "./useAssistantFlows";

function AssistantCard(props: {
  readonly entry: AssistantEntry;
  readonly groupNames: ReadonlyArray<string>;
  readonly projectLabel: string;
  readonly detail: ReadonlyArray<string>;
  readonly nowMs: number;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const openEditor = useOpenAssistantEditor();
  const archived = assistant.archivedAt !== null;
  const presence = assistantPresence(
    useThreadShell(
      assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId),
    ),
  );
  const budgetState = useAssistantSpend(environmentId, assistant.budget ? assistant.id : null).data
    ?.budget?.state;
  const status = archived
    ? "Archived"
    : presence.since === null
      ? presence.detail
      : `${presence.detail} · ${relativeTime(presence.since, props.nowMs)}`;
  const where = [
    props.projectLabel,
    ...props.detail,
    budgetState === "exceeded" ? "Limit reached" : budgetState === "warn" ? "Near limit" : null,
  ].filter((part): part is string => part !== null);
  return (
    <View
      accessible
      accessibilityLabel={`${assistant.name}, ${where.join(", ")}`}
      className="gap-3 rounded-2xl bg-grouped-card p-4"
    >
      <View className="flex-row items-start gap-3">
        <AssistantAvatar
          assistant={assistant}
          environmentId={environmentId}
          mood={archived ? "idle" : presence.mood}
          size={44}
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text textRole="body" className="shrink text-foreground" numberOfLines={1}>
              {assistant.name}
            </Text>
            {assistant.role === "" ? null : (
              <View className="max-w-28 rounded-md border border-border px-1.5 py-px">
                <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                  {assistant.role}
                </Text>
              </View>
            )}
          </View>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {where.join(" · ")}
          </Text>
          <Text
            textRole="footnote"
            className={archived ? "text-foreground-muted" : moodTextClass(presence.mood)}
            numberOfLines={1}
          >
            {status}
          </Text>
        </View>
      </View>
      {props.groupNames.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-1">
          {props.groupNames.map((name) => (
            <View key={name} className="rounded-md border border-border px-1.5 py-px">
              <Text className="text-2xs text-foreground-muted">{name}</Text>
            </View>
          ))}
        </View>
      )}
      <View className="flex-row flex-wrap items-center gap-2">
        {archived ? (
          <Button
            label="Restore"
            icon="arrow.uturn.backward"
            size="compact"
            disabled={!flows.canAct}
            onPress={() => void flows.unarchive(assistant)}
          />
        ) : (
          <>
            <Button
              label="Open thread"
              size="compact"
              disabled={assistant.threadId === null}
              onPress={() => flows.openConversation(assistant)}
            />
            <Button
              label="Edit"
              icon="gearshape"
              tone="text"
              size="compact"
              onPress={() => openEditor(environmentId, assistant)}
            />
            <Button
              label="Archive"
              icon="archivebox"
              tone="text"
              size="compact"
              disabled={!flows.canAct}
              onPress={() => flows.archive(assistant)}
            />
          </>
        )}
      </View>
    </View>
  );
}

function Section(props: {
  readonly title: string;
  readonly count?: number;
  readonly tone?: string;
  readonly actions?: ReactNode;
  readonly empty?: string;
  readonly children?: ReactNode;
}) {
  return (
    <View accessibilityLabel={props.title} className="gap-2">
      <View className="min-h-9 flex-row items-center gap-2 px-2">
        <Text
          className={cn(
            "min-w-0 shrink font-t3-bold text-2xs uppercase tracking-[1.1px]",
            props.tone ?? "text-foreground-secondary",
          )}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        {props.count === undefined ? null : (
          <Text className="text-xs text-foreground-muted">{props.count}</Text>
        )}
        <View className="flex-1 flex-row items-center justify-end gap-1">{props.actions}</View>
      </View>
      {props.empty === undefined ? (
        <View className="gap-3">{props.children}</View>
      ) : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {props.empty}
        </Text>
      )}
    </View>
  );
}

function SectionAction(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={6}
      onPress={props.onPress}
      className="min-h-9 justify-center px-1 active:opacity-70"
    >
      <Text textRole="footnote" className="font-t3-medium text-primary-text">
        {props.label}
      </Text>
    </Pressable>
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

/** Every assistant as a card, grouped like Home, with Open thread, Edit and Archive on each. */
export function SettingsAssistantsRouteScreen() {
  const { active, archived, teams, environmentIds: loadedEnvironmentIds } = useAssistantEntries();
  const navigation = useNavigation();
  const openTeam = useOpenAssistantTeam();
  const insets = useSafeAreaInsets();
  const openEditor = useOpenAssistantEditor();
  const projects = useProjects();
  const shells = useQuietThreadShells();
  const nowMs = useNowMinuteMs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentIds = useAssistantsEnvironmentIds();
  const firstEnvironmentId = loadedEnvironmentIds[0] ?? null;

  const keyByThread = new Map(
    active.flatMap((entry) =>
      entry.assistant.threadId === null
        ? []
        : [
            [
              scopedThreadKey(scopeThreadRef(entry.environmentId, entry.assistant.threadId)),
              assistantEntryKey(entry),
            ] as const,
          ],
    ),
  );
  const needsKeys = new Set<string>();
  for (const shell of shells) {
    const key = keyByThread.get(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)));
    if (key !== undefined && assistantPresence(shell).mood === "needs") needsKeys.add(key);
  }
  const sections = assistantSections({ assistants: active, teams, needsKeys });

  const projectName = (environmentId: string, projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "Project";
  const groupNamesOf = (entry: AssistantEntry) =>
    teams
      .filter(
        (candidate: AssistantTeamEntry) =>
          candidate.environmentId === entry.environmentId &&
          candidate.team.memberIds.includes(entry.assistant.id),
      )
      .map((candidate) => candidate.team.name);
  const detailOf = (entry: AssistantEntry) => {
    const subtitle = teamSubtitle(
      entry.assistant,
      [...active, ...archived]
        .filter((other) => other.environmentId === entry.environmentId)
        .map((other) => other.assistant),
    );
    return [
      ...(subtitle === null ? [] : [subtitle]),
      ...(loadedEnvironmentIds.length > 1 && savedConnectionsById[entry.environmentId]
        ? [savedConnectionsById[entry.environmentId]!.environmentLabel]
        : []),
    ];
  };
  const card = (entry: AssistantEntry, keyPrefix: string) => (
    <AssistantCard
      key={`${keyPrefix}:${assistantEntryKey(entry)}`}
      entry={entry}
      groupNames={groupNamesOf(entry)}
      detail={detailOf(entry)}
      nowMs={nowMs}
      projectLabel={
        entry.assistant.scope === "project"
          ? projectName(entry.environmentId, entry.assistant.projectId)
          : "All projects"
      }
    />
  );
  const nothing = active.length === 0 && archived.length === 0 && teams.length === 0;

  return (
    <SettingsScreen
      title="Assistants"
      actions={
        firstEnvironmentId === null
          ? []
          : [
              {
                accessibilityLabel: "Describe one and let T3 build it",
                icon: "sparkles",
                onPress: () => navigation.navigate("SettingsAssistantDescribe"),
              },
              {
                accessibilityLabel: "New group",
                icon: "person.2",
                onPress: () => openTeam.edit(firstEnvironmentId, null),
              },
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
            {nothing ? (
              <EmptyState
                variant="plain"
                title="No assistants yet"
                detail="An assistant keeps one long conversation you can come back to. Create one to get started."
              />
            ) : null}
            {sections.needs.length === 0 ? null : (
              <Section
                title="Needs you"
                count={sections.needs.length}
                tone="text-warning-foreground"
              >
                {sections.needs.map((entry) => card(entry, "needs"))}
              </Section>
            )}
            {sections.groups.map(({ team: entry, members }) => (
              <Section
                key={`${entry.environmentId}:${entry.team.id}`}
                title={entry.team.name}
                count={members.length}
                {...(members.length === 0 ? { empty: "No members yet." } : {})}
                actions={
                  <>
                    <SectionAction
                      label={`New assistant in ${entry.team.name}`}
                      onPress={() =>
                        openEditor(entry.environmentId, null, { teamId: entry.team.id })
                      }
                    />
                    <SectionAction
                      label={`Activity of ${entry.team.name}`}
                      onPress={() => openTeam.activity(entry.environmentId, entry.team.id)}
                    />
                    <SectionAction
                      label={`Edit ${entry.team.name}`}
                      onPress={() => openTeam.edit(entry.environmentId, entry.team.id)}
                    />
                  </>
                }
              >
                {members.map((member) => card(member, `group:${entry.team.id}`))}
              </Section>
            ))}
            {sections.projects.map((project) => (
              <Section
                key={`${project.environmentId}:${project.projectId}`}
                title={projectName(project.environmentId, project.projectId)}
                count={project.members.length}
                actions={
                  <SectionAction
                    label={`New assistant in ${projectName(project.environmentId, project.projectId)}`}
                    onPress={() =>
                      openEditor(EnvironmentId.make(project.environmentId), null, {
                        projectId: ProjectId.make(project.projectId),
                      })
                    }
                  />
                }
              >
                {project.members.map((member) => card(member, `project:${project.projectId}`))}
              </Section>
            ))}
            {sections.unassigned.length === 0 ? null : (
              <Section title="Unassigned" count={sections.unassigned.length}>
                {sections.unassigned.map((entry) => card(entry, "unassigned"))}
              </Section>
            )}
            {archived.length === 0 ? null : (
              <Section title="Archived" count={archived.length}>
                {archived.map((entry) => card(entry, "archived"))}
              </Section>
            )}
            {loadedEnvironmentIds
              .filter(
                (environmentId) =>
                  ![...active, ...archived].some(
                    (entry) => entry.environmentId === environmentId && entry.assistant.isDefault,
                  ),
              )
              .map((environmentId) => (
                <ListSection key={`restore:${environmentId}`}>
                  <RestoreJarvisRow environmentId={environmentId} />
                </ListSection>
              ))}
            {environmentIds.map((environmentId) => (
              <AssistantSandboxSection
                key={`sandbox:${environmentId}`}
                environmentId={environmentId}
                suffix={
                  environmentIds.length > 1
                    ? ` · ${savedConnectionsById[environmentId]?.environmentLabel ?? environmentId}`
                    : ""
                }
              />
            ))}
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
