import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { assistantGroupLatestSeq } from "@t3tools/client-runtime/assistantGroupChat";
import {
  ASSISTANT_TEAM_INSTRUCTIONS_MAX_CHARS,
  ASSISTANT_TEAM_MEMORIES_MAX,
  ASSISTANT_TEAM_MEMORY_MAX_CHARS,
  type AssistantGroupConversationAction,
  type AssistantTeam,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useRef, useState, type ComponentRef } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  useAssistantEntries,
  useAssistantGroupActions,
  useAssistantGroupChat,
  useAssistantTeamActions,
} from "../../state/assistants";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { TextField } from "./AssistantFormFields";
import { GroupRoutinesSection } from "./GroupRoutinesSection";
import { assistantTeamTargetAtom, type AssistantTeamTarget } from "./assistantTeamTarget";

export function AssistantGroupSettingsRouteScreen() {
  const target = useAtomValue(assistantTeamTargetAtom);
  const { teams } = useAssistantEntries();
  const team =
    target?.teamId == null
      ? undefined
      : teams.find(
          (entry) =>
            entry.environmentId === target.environmentId && entry.team.id === target.teamId,
        )?.team;
  if (target === null || team === undefined) {
    return (
      <SettingsScreen title="Group settings">
        <Text className="p-5 text-base text-foreground-muted">Open a group first.</Text>
      </SettingsScreen>
    );
  }
  return (
    <SettingsForm
      key={`${target.environmentId}:${team.id}`}
      environmentId={target.environmentId}
      team={team}
      section={target.section}
    />
  );
}

/** One memory per line: blank lines are dropped. */
const memoriesOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

function SettingsForm(props: {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
  readonly section: AssistantTeamTarget["section"];
}) {
  const { environmentId, team, section } = props;
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const teamActions = useAssistantTeamActions(environmentId);
  const groupActions = useAssistantGroupActions(environmentId);
  const chat = useAssistantGroupChat(environmentId, team.id);
  const [instructions, setInstructions] = useState(team.instructions ?? "");
  const [memories, setMemories] = useState((team.memories ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const working = team.chat?.working === true;
  const latest = chat === null ? 0 : assistantGroupLatestSeq(chat);
  const endsWithBoundary =
    chat !== null &&
    [...chat.messages.values()].some(
      (message) => message.seq === latest && message.kind === "boundary",
    );
  const kept = memoriesOf(memories);
  const changed =
    instructions.trim() !== (team.instructions ?? "") ||
    JSON.stringify(kept) !== JSON.stringify(team.memories ?? []);
  const converseDisabled = busy || working || !groupActions.canConverse;

  const save = async () => {
    setBusy(true);
    setError(null);
    const reply = await teamActions.update({
      teamId: team.id,
      instructions: instructions.trim(),
      memories: kept.slice(0, ASSISTANT_TEAM_MEMORIES_MAX),
    });
    setBusy(false);
    if (reply.ok) navigation.goBack();
    else setError(reply.message);
  };

  const converse = async (action: AssistantGroupConversationAction) => {
    setBusy(true);
    setError(null);
    const reply = await groupActions.conversation(team.id, action);
    setBusy(false);
    if (reply.ok) navigation.goBack();
    else setError(reply.message);
  };

  const clear = () =>
    Dialog.confirm({
      title: `Clear the history of ${team.name}?`,
      message:
        "Every message, task and file in this chat is deleted. Members keep their own conversations. This cannot be undone.",
      confirmText: "Clear history",
      destructive: true,
      onConfirm: () => void converse("clear"),
    });

  return (
    <SettingsScreen title={`${team.name} settings`}>
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <TextField
          label="Group instructions"
          description="Sent to every member with each task, on top of its own instructions."
          value={instructions}
          maxLength={ASSISTANT_TEAM_INSTRUCTIONS_MAX_CHARS}
          multiline
          autoCapitalize="sentences"
          onChange={setInstructions}
          footer={
            <Text className="text-end text-xs text-foreground-muted">
              {instructions.length.toLocaleString()} /{" "}
              {ASSISTANT_TEAM_INSTRUCTIONS_MAX_CHARS.toLocaleString()}
            </Text>
          }
        />
        <TextField
          label="Group memories"
          description={`Short facts every member should remember. One per line, up to ${ASSISTANT_TEAM_MEMORIES_MAX}, ${ASSISTANT_TEAM_MEMORY_MAX_CHARS} characters each.`}
          value={memories}
          multiline
          autoCapitalize="sentences"
          onChange={setMemories}
        />
        {error === null ? null : (
          <Text
            accessibilityRole="alert"
            textRole="footnote"
            className="px-2 text-danger-foreground"
          >
            {error}
          </Text>
        )}
        <Button
          label="Save"
          tone="primary"
          fullWidth
          loading={busy}
          disabled={busy || !changed || !teamActions.canAct}
          onPress={() => void save()}
        />
        <View
          onLayout={
            section === "routines"
              ? (event) =>
                  scrollRef.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false })
              : undefined
          }
        >
          <GroupRoutinesSection environmentId={environmentId} teamId={team.id} />
        </View>
        <ListSection
          title="Conversation"
          footer={
            working
              ? "The group is working. Stop its tasks to change the conversation."
              : "Start over without losing the chat: older messages stay above a divider."
          }
        >
          <ListActionRow
            icon="plus.bubble"
            label="New conversation"
            description="Members read only what comes next. The summary starts over."
            disabled={converseDisabled}
            onPress={() => void converse("new")}
          />
          <ListActionRow
            icon="arrow.down.right.and.arrow.up.left"
            label="Compact context"
            description="Summarizes the chat so far, then starts a new conversation from the summary."
            disabled={converseDisabled}
            onPress={() => void converse("compact")}
          />
          {endsWithBoundary ? (
            <ListActionRow
              icon="arrow.uturn.backward"
              label="Undo divider"
              description="Removes the latest divider while nothing follows it."
              disabled={busy || !groupActions.canConverse}
              onPress={() => void converse("undo")}
            />
          ) : null}
          <ListActionRow
            icon="trash"
            tone="danger"
            label="Clear history"
            description="Deletes every message, task and file of this chat."
            disabled={converseDisabled}
            onPress={clear}
          />
        </ListSection>
      </ScrollView>
    </SettingsScreen>
  );
}
