import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  ASSISTANT_GROUP_STATUS_LABEL,
  assistantGroupRunningTasks,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  assistantAskBeforeActingLabel,
  assistantGroupInfoSummary,
  assistantGroupMembers,
  assistantInfoGroups,
  assistantInfoProjects,
} from "@t3tools/client-runtime/assistantInfo";
import {
  assistantWorkingHereLabel,
  assistantWorkingNow,
} from "@t3tools/client-runtime/assistantLiveWork";
import { assistantFace } from "@t3tools/client-runtime/assistantRobot";
import { PROBLEM_LEVEL_LEGEND, problemLevelLabel } from "@t3tools/client-runtime/autonomy";
import { assistantProjectsChip } from "@t3tools/client-runtime/assistantSections";
import { ASSISTANT_TASK_STATE_LABEL } from "@t3tools/client-runtime/assistantTasks";
import { AssistantId, AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import { useEffect, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button, type ButtonProps } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { useModelDisplayName } from "../settings/components/SettingsModelPicker";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import {
  type AssistantEntry,
  type AssistantTeamEntry,
  useAssistantEntries,
  useAssistantGroupChat,
  useAssistantLiveWork,
  useAssistantStatus,
  useAssistantSpend,
} from "../../state/assistants";
import { useProjects, useThreadShells } from "../../state/entities";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { assistantStatusText, moodTextClass } from "./assistantPresenceLabels";
import {
  AssistantAvatar,
  AssistantCluster,
  budgetSpendLine,
  removedAssistantFace,
  toolAccessLabel,
} from "./assistantPresentation";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useOpenAssistantWork } from "./assistantWorkTarget";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useAssistantFlows, useAssistantTeamFlows } from "./useAssistantFlows";
import { useUsageLimitLabel } from "./useUsageLimitLabel";

function Hero(props: {
  readonly face: ReactNode;
  readonly name: string;
  readonly role?: string;
  readonly status: string;
  readonly statusClass: string;
}) {
  return (
    <View className="items-center gap-1 pt-2">
      {props.face}
      <Text textRole="title" className="mt-2 text-foreground" numberOfLines={1}>
        {props.name}
      </Text>
      {props.role ? (
        <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
          {props.role}
        </Text>
      ) : null}
      <Text
        testID="assistant-info-status"
        textRole="footnote"
        className={props.statusClass}
        numberOfLines={1}
      >
        {props.status}
      </Text>
    </View>
  );
}

function Actions(props: { readonly children: ReactNode }) {
  return <View className="flex-row gap-2">{props.children}</View>;
}

function ActionButton(props: ButtonProps) {
  return (
    <View className="min-w-0 flex-1">
      <Button size="tile" fullWidth {...props} />
    </View>
  );
}

/** A deleted subject closes its info rather than showing stale data, once its environment has loaded. */
function useCloseWhenGone(environmentId: EnvironmentId, found: boolean) {
  const navigation = useNavigation();
  const { environmentIds } = useAssistantEntries();
  const gone = !found && environmentIds.includes(environmentId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaving the screen is navigation, outside React
  useEffect(() => {
    if (gone && navigation.canGoBack()) navigation.goBack();
  }, [gone, navigation]);
}

function Field(props: {
  readonly label: string;
  readonly value?: string;
  readonly icon?: AppSymbolName;
}) {
  return (
    <ListRowLayout
      label={props.label}
      {...(props.icon === undefined ? {} : { icon: props.icon })}
      {...(props.value === undefined ? {} : { detail: props.value })}
      accessory={null}
    />
  );
}

function useProjectName(environmentId: EnvironmentId) {
  const projects = useProjects();
  return (projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "Project";
}

function AssistantInfoBody(props: { readonly entry: AssistantEntry }) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const openEditor = useOpenAssistantEditor();
  const openWork = useOpenAssistantWork();
  const openTeam = useOpenAssistantTeam();
  const selectDetail = useSelectWorkspaceDetail();
  const shells = useThreadShells();
  const status = useAssistantStatus();
  const limitLabel = useUsageLimitLabel();
  const modelName = useModelDisplayName(environmentId, assistant.projectId);
  const work = useAssistantLiveWork();
  const nowMs = useNowMinuteMs();
  const { teams } = useAssistantEntries();
  const nameOf = useProjectName(environmentId);
  const spend = useAssistantSpend(
    environmentId,
    assistant.budget === null ? null : assistant.id,
  ).data;
  const archived = assistant.archivedAt !== null;
  const presence = status.of(environmentId, assistant, limitLabel);
  const workingNow = archived ? [] : assistantWorkingNow(work, environmentId, assistant.id);
  const projects = assistantInfoProjects(assistant, workingNow, nameOf);
  const groups = assistantInfoGroups(
    teams.filter((entry) => entry.environmentId === environmentId),
    assistant.id,
  );
  const thread = shells.find(
    (shell) => shell.environmentId === environmentId && shell.id === assistant.threadId,
  );
  const titleOf = (threadId: string) =>
    shells.find((shell) => shell.environmentId === environmentId && shell.id === threadId)?.title ??
    "";
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-5 pt-4 pb-10"
    >
      <Hero
        face={
          <AssistantAvatar
            assistant={assistant}
            environmentId={environmentId}
            mood={archived ? "sleeping" : assistantFace(presence, nowMs)}
            size={88}
          />
        }
        name={assistant.name}
        role={assistant.role}
        status={archived ? "Archived" : assistantStatusText(presence, nowMs)}
        statusClass={archived ? "text-foreground-muted" : moodTextClass(presence.mood)}
      />
      <Actions>
        <ActionButton
          label="Open chat"
          icon="bubble.left.and.bubble.right"
          disabled={assistant.threadId === null}
          onPress={() => flows.openConversation(assistant)}
        />
        <ActionButton
          label="Edit"
          icon="gearshape"
          onPress={() => openEditor(environmentId, assistant)}
        />
        <ActionButton
          label="Work"
          icon="briefcase"
          onPress={() => openWork(environmentId, assistant.id)}
        />
      </Actions>
      {archived ? null : (
        <ListSection title="Working now">
          {workingNow.length === 0 ? (
            <Field label="Nothing running" />
          ) : (
            workingNow.map((site) => (
              <ListRow
                key={site.threadId}
                leading={<AssistantAvatar assistant={assistant} mood={site.face} size={24} />}
                label={titleOf(site.threadId)}
                description={nameOf(site.projectId)}
                detail={ASSISTANT_TASK_STATE_LABEL[site.face === "waiting" ? "waiting" : "running"]}
                onPress={() =>
                  selectDetail({
                    name: "Thread",
                    params: { environmentId: String(environmentId), threadId: site.threadId },
                  })
                }
              />
            ))
          )}
        </ListSection>
      )}
      <ListSection title="Projects">
        {projects.all ? <Field label="All projects" /> : null}
        {projects.rows.map((row) => (
          <Field
            key={row.projectId}
            label={row.name}
            {...(row.workingNow ? { value: assistantWorkingHereLabel(assistant.name) } : {})}
          />
        ))}
      </ListSection>
      {groups.length === 0 ? null : (
        <ListSection title="Groups">
          {groups.map(({ entry, lead }) => (
            <ListRow
              key={entry.team.id}
              icon="person.2"
              label={entry.team.name}
              {...(lead ? { detail: "Lead" } : {})}
              onPress={() => openTeam.chat(environmentId, entry.team.id)}
            />
          ))}
        </ListSection>
      )}
      <ListSection title="Access">
        <Field icon="key" label="Tool access" value={toolAccessLabel(assistant.toolAccess)} />
        <Field
          icon="questionmark.bubble"
          label="Asks before acting"
          value={assistantAskBeforeActingLabel(assistant.askBeforeActing)}
        />
        {thread ? (
          <Field icon="brain" label="Model" value={modelName(thread.modelSelection)} />
        ) : null}
        <Field
          icon="wrench.and.screwdriver"
          label={PROBLEM_LEVEL_LEGEND}
          value={problemLevelLabel(assistant.autonomy.onProblem)}
        />
        {assistant.budget !== null && spend ? (
          <Field
            icon="gauge.with.dots.needle.50percent"
            label="Spending limit"
            value={budgetSpendLine(spend)}
          />
        ) : null}
      </ListSection>
      <ListSection>
        {archived ? (
          <ListActionRow
            icon="arrow.uturn.backward"
            label="Restore"
            disabled={!flows.canAct}
            onPress={() => void flows.unarchive(assistant)}
          />
        ) : (
          <ListActionRow
            icon="archivebox"
            tone="danger"
            label="Archive assistant"
            disabled={!flows.canAct}
            onPress={() => flows.archive(assistant)}
          />
        )}
      </ListSection>
    </ScrollView>
  );
}

function GroupInfoBody(props: { readonly entry: AssistantTeamEntry }) {
  const { team, environmentId } = props.entry;
  const navigation = useNavigation();
  const flows = useAssistantTeamFlows(environmentId);
  const openTeam = useOpenAssistantTeam();
  const shells = useThreadShells();
  const status = useAssistantStatus();
  const limitLabel = useUsageLimitLabel();
  const { active, archived: archivedAssistants } = useAssistantEntries();
  const chat = useAssistantGroupChat(environmentId, team.id);
  const nameOf = useProjectName(environmentId);
  const archived = team.archivedAt !== null;
  const members = assistantGroupMembers(
    team,
    [...active, ...archivedAssistants]
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry) => entry.assistant),
  );
  const running = chat === null ? [] : assistantGroupRunningTasks(chat);
  const ownerFace = (id: string) =>
    members.find((member) => member.id === id)?.assistant ?? removedAssistantFace(id);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-5 pt-4 pb-10"
    >
      <Hero
        face={
          <AssistantCluster
            environmentId={environmentId}
            size={88}
            faces={members.map((member) => ({
              key: member.id,
              assistant: member.assistant ?? removedAssistantFace(member.id),
              mood: member.assistant
                ? assistantFace(status.of(environmentId, member.assistant, limitLabel))
                : "sleeping",
            }))}
          />
        }
        name={team.name}
        status={archived ? "Archived" : assistantGroupInfoSummary(members.length, running.length)}
        statusClass="text-foreground-muted"
      />
      <Actions>
        <ActionButton
          label="Open chat"
          icon="bubble.left.and.bubble.right"
          onPress={() => openTeam.chat(environmentId, team.id)}
        />
        <ActionButton
          label="Edit group"
          icon="pencil"
          onPress={() => openTeam.edit(environmentId, team.id)}
        />
        <ActionButton
          label="Group settings"
          icon="gearshape"
          onPress={() => openTeam.settings(environmentId, team.id)}
        />
      </Actions>
      {archived ? null : (
        <ListSection title="Working now">
          {running.length === 0 ? (
            <Field label="Nothing running" />
          ) : (
            running.map((task) => {
              const shell = shells.find(
                (candidate) =>
                  candidate.environmentId === environmentId && candidate.id === task.threadId,
              );
              return (
                <ListRowLayout
                  key={task.id}
                  leading={
                    <AssistantAvatar assistant={ownerFace(task.ownerId)} mood="working" size={24} />
                  }
                  label={task.instruction}
                  {...(shell ? { description: nameOf(shell.projectId) } : {})}
                  detail={ASSISTANT_GROUP_STATUS_LABEL[task.status]}
                  accessory={null}
                />
              );
            })
          )}
        </ListSection>
      )}
      <ListSection title="Members">
        {members.map((member) => {
          const memberAssistant = member.assistant;
          const presence = status.of(environmentId, memberAssistant, limitLabel);
          const leading = (
            <AssistantAvatar
              assistant={memberAssistant ?? removedAssistantFace(member.id)}
              environmentId={environmentId}
              mood={memberAssistant ? assistantFace(presence) : "sleeping"}
              size={28}
            />
          );
          const label = memberAssistant?.name ?? "Assistant";
          if (memberAssistant === null) {
            return (
              <ListRowLayout key={member.id} leading={leading} label={label} accessory={null} />
            );
          }
          return (
            <ListRow
              key={member.id}
              leading={leading}
              label={label}
              description={`${presence.detail} · ${assistantProjectsChip(memberAssistant, nameOf)}`}
              {...(member.lead ? { detail: "Lead" } : {})}
              onPress={() =>
                navigation.navigate("AssistantInfo", {
                  environmentId,
                  assistantId: memberAssistant.id,
                })
              }
            />
          );
        })}
      </ListSection>
      <ListSection>
        <ListRow
          icon="text.alignleft"
          label="Instructions"
          onPress={() => openTeam.settings(environmentId, team.id)}
        />
        <ListRow
          icon="brain"
          label="Memories"
          onPress={() => openTeam.settings(environmentId, team.id)}
        />
        <ListRow
          icon="calendar.badge.clock"
          label="Routines"
          onPress={() => openTeam.settings(environmentId, team.id, "routines")}
        />
      </ListSection>
      <ListSection>
        {archived ? (
          <ListActionRow
            icon="arrow.uturn.backward"
            label="Restore group"
            disabled={!flows.canAct}
            onPress={() => void flows.restore(team)}
          />
        ) : (
          <ListActionRow
            icon="archivebox"
            tone="danger"
            label="Archive group"
            disabled={!flows.canAct}
            onPress={() => flows.archive(team)}
          />
        )}
      </ListSection>
    </ScrollView>
  );
}

/** Who an assistant is, where it may work and what it does now; a deleted one shows nothing stale. */
export function AssistantInfoRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: string; readonly assistantId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const assistantId = AssistantId.make(route.params.assistantId);
  const { active, archived } = useAssistantEntries();
  const entry = [...active, ...archived].find(
    (candidate) =>
      candidate.environmentId === environmentId && candidate.assistant.id === assistantId,
  );
  useCloseWhenGone(environmentId, entry !== undefined);
  return (
    <SettingsScreen title="Assistant info">
      {entry ? <AssistantInfoBody key={`${environmentId}:${assistantId}`} entry={entry} /> : null}
    </SettingsScreen>
  );
}

/** Who is in a group, what it runs now, and its editors. */
export function AssistantGroupInfoRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: string; readonly teamId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const teamId = AssistantTeamId.make(route.params.teamId);
  const { teams } = useAssistantEntries();
  const entry = teams.find(
    (candidate) => candidate.environmentId === environmentId && candidate.team.id === teamId,
  );
  useCloseWhenGone(environmentId, entry !== undefined);
  return (
    <SettingsScreen title="Group info">
      {entry ? <GroupInfoBody key={`${environmentId}:${teamId}`} entry={entry} /> : null}
    </SettingsScreen>
  );
}
