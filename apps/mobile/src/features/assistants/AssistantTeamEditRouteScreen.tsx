import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { NO_LEADER_LABEL, teamMemberChoices } from "@t3tools/client-runtime/assistantTeam";
import {
  ASSISTANT_TEAM_NAME_MAX_LENGTH,
  ASSISTANT_TEAM_TITLE_MAX_LENGTH,
  assistantTeamProblem,
  type AssistantId,
  type AssistantTeam,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAssistantEntries, useAssistantTeamActions } from "../../state/assistants";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ChoiceRow, FieldHeader, TextField } from "./AssistantFormFields";
import { assistantTeamTargetAtom } from "./assistantTeamTarget";

export function AssistantTeamEditRouteScreen() {
  const target = useAtomValue(assistantTeamTargetAtom);
  const { teams } = useAssistantEntries();
  if (target === null) {
    return (
      <SettingsScreen title="Team">
        <Text className="p-5 text-base text-foreground-muted">Open a team first.</Text>
      </SettingsScreen>
    );
  }
  const existing =
    target.teamId === null
      ? null
      : (teams.find(
          (entry) =>
            entry.environmentId === target.environmentId && entry.team.id === target.teamId,
        )?.team ?? null);
  return (
    <TeamForm
      key={`${target.environmentId}:${target.teamId}`}
      environmentId={target.environmentId}
      team={existing}
    />
  );
}

function TeamForm(props: {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam | null;
}) {
  const { team, environmentId } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const actions = useAssistantTeamActions(environmentId);
  const { active, archived } = useAssistantEntries();
  const choices = teamMemberChoices(
    [...active, ...archived]
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry) => entry.assistant),
    team,
  );
  const [name, setName] = useState(team?.name ?? "");
  const [memberIds, setMemberIds] = useState<ReadonlyArray<AssistantId>>(team?.memberIds ?? []);
  const [leaderId, setLeaderId] = useState<AssistantId | null>(team?.leaderId ?? null);
  const [leaderTitle, setLeaderTitle] = useState(team?.leaderTitle ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveLeader = leaderId !== null && memberIds.includes(leaderId) ? leaderId : null;
  const problem = assistantTeamProblem({ memberIds, leaderId: effectiveLeader });
  const canSave = !saving && actions.canAct && name.trim() !== "" && problem === null;

  const toggle = (id: AssistantId) =>
    setMemberIds((current) =>
      current.includes(id) ? current.filter((memberId) => memberId !== id) : [...current, id],
    );

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const title = effectiveLeader === null ? null : leaderTitle.trim() || null;
    const reply = team
      ? await actions.update({
          teamId: team.id,
          name: name.trim(),
          memberIds,
          leaderId: effectiveLeader,
          leaderTitle: title,
        })
      : await actions.create({
          name: name.trim(),
          memberIds,
          leaderId: effectiveLeader,
          leaderTitle: title,
        });
    setSaving(false);
    if (reply.ok) navigation.goBack();
    else setError(reply.message);
  };

  const remove = () => {
    if (team === null) return;
    Dialog.confirm({
      title: `Delete the team ${team.name}?`,
      message: "Its members stay; they just stop being able to message each other as a team.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          const reply = await actions.remove(team.id);
          if (reply.ok) navigation.goBack();
          else Dialog.alert("Could not delete the team", reply.message);
        })();
      },
    });
  };

  return (
    <SettingsScreen title={team ? `${team.name} team` : "New team"}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <TextField
          label="Name"
          description="Shown in Settings and on Home."
          value={name}
          maxLength={ASSISTANT_TEAM_NAME_MAX_LENGTH}
          autoCapitalize="sentences"
          onChange={setName}
        />
        <View className="gap-2">
          <FieldHeader
            label="Members"
            description="At least two. Members can message each other in any direction, and you can follow what they say."
          />
          <ListSection>
            {choices.map((assistant) => (
              <ChoiceRow
                key={assistant.id}
                role="checkbox"
                icon="person.crop.circle"
                label={assistant.name}
                description={assistant.archivedAt === null ? undefined : "Archived"}
                selected={memberIds.includes(assistant.id)}
                onPress={() => toggle(assistant.id)}
              />
            ))}
          </ListSection>
        </View>
        <View className="gap-2">
          <FieldHeader
            label="Leader"
            description="Optional. Teammates are told to report their results to the leader. It does not change who may message whom."
          />
          <ListSection>
            <ChoiceRow
              role="radio"
              icon="person.fill.xmark"
              label={NO_LEADER_LABEL}
              selected={effectiveLeader === null}
              onPress={() => setLeaderId(null)}
            />
            {choices
              .filter((assistant) => memberIds.includes(assistant.id))
              .map((assistant) => (
                <ChoiceRow
                  key={assistant.id}
                  role="radio"
                  icon="star.fill"
                  label={assistant.name}
                  selected={effectiveLeader === assistant.id}
                  onPress={() => setLeaderId(assistant.id)}
                />
              ))}
          </ListSection>
        </View>
        {effectiveLeader === null ? null : (
          <TextField
            label="Leader title"
            description="CEO, CFO, Head of Research… Agents and the team view show it."
            value={leaderTitle}
            maxLength={ASSISTANT_TEAM_TITLE_MAX_LENGTH}
            autoCapitalize="sentences"
            placeholder="CEO"
            onChange={setLeaderTitle}
          />
        )}
        {error ? (
          <Text
            accessibilityRole="alert"
            textRole="footnote"
            className="px-2 text-danger-foreground"
          >
            {error}
          </Text>
        ) : null}
        <Button
          label={team ? "Save" : "Create team"}
          tone="primary"
          fullWidth
          loading={saving}
          disabled={!canSave}
          onPress={() => void save()}
        />
        {team ? (
          <ListSection title="Manage">
            <ListActionRow
              icon="trash"
              tone="danger"
              label="Delete team"
              description="Members stay; the team and its shortcut go away."
              disabled={!actions.canAct}
              onPress={remove}
            />
          </ListSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
