import { useAtomValue } from "@effect/atom-react";
import { teamLeaderBadge, teamSummary } from "@t3tools/client-runtime/assistantTeam";
import type {
  Assistant,
  AssistantTeam,
  AssistantTeamMessage,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAssistantEntries, useAssistantTeamActivity } from "../../state/assistants";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { AssistantAvatar } from "./assistantPresentation";
import { assistantTeamTargetAtom } from "./assistantTeamTarget";
import { useAssistantFlows } from "./useAssistantFlows";

const FOLD_LENGTH = 280;
const FOLDED_HEIGHT = 96;

/** Markdown that folds behind "Show more" when long, like decision context. */
function FoldedMarkdown(props: { readonly markdown: string; readonly label: string }) {
  const [expanded, setExpanded] = useState(false);
  const styles = useMarkdownPreviewStyles();
  const foldable = props.markdown.length > FOLD_LENGTH || props.markdown.split("\n").length > 5;
  return (
    <View className="items-start gap-1">
      <View
        className="w-full overflow-hidden"
        style={foldable && !expanded ? { maxHeight: FOLDED_HEIGHT } : undefined}
      >
        <SelectableMarkdownText markdown={props.markdown} textStyle={styles.nativeTextStyle} />
      </View>
      {foldable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Show less" : "Show more"} of the ${props.label}`}
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => setExpanded((value) => !value)}
          className="active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function AssistantTeamActivityRouteScreen() {
  const target = useAtomValue(assistantTeamTargetAtom);
  const { teams } = useAssistantEntries();
  const team =
    target === null
      ? null
      : (teams.find(
          (entry) =>
            entry.environmentId === target.environmentId && entry.team.id === target.teamId,
        )?.team ?? null);
  if (target === null || team === null) {
    return (
      <SettingsScreen title="Team activity">
        <Text className="p-5 text-base text-foreground-muted">Open a team first.</Text>
      </SettingsScreen>
    );
  }
  return <Activity environmentId={target.environmentId} team={team} />;
}

function MessageRow(props: {
  readonly environmentId: EnvironmentId;
  readonly message: AssistantTeamMessage;
  readonly team: AssistantTeam;
  readonly assistants: ReadonlyMap<string, Assistant>;
}) {
  const { message, team } = props;
  const flows = useAssistantFlows(props.environmentId);
  const reply = message.reply;
  const from = props.assistants.get(message.fromAssistantId);
  const to = props.assistants.get(message.toAssistantId);
  const name = (assistant: Assistant | undefined, id: string) =>
    `${assistant?.name ?? id}${team.leaderId === id ? ` (${teamLeaderBadge(team)})` : ""}`;
  return (
    <View className="gap-1.5 rounded-2xl bg-grouped-card px-4 py-3">
      <View className="flex-row items-center gap-2">
        {from ? <AssistantAvatar assistant={from} size={24} /> : null}
        <Text textRole="footnote" className="min-w-0 flex-1 font-t3-medium text-foreground">
          {name(from, message.fromAssistantId)} to {name(to, message.toAssistantId)}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {new Date(message.at).toLocaleString()}
        </Text>
      </View>
      <FoldedMarkdown markdown={message.text} label="message" />
      <View className="ml-3 gap-1 border-l-2 border-foreground/12 pl-3">
        {reply === null ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {message.waiting ? "Waiting for a reply…" : "No reply"}
          </Text>
        ) : (
          <>
            <View className="flex-row items-center gap-2">
              {to ? <AssistantAvatar assistant={to} size={20} /> : null}
              <Text textRole="footnote" className="min-w-0 flex-1 font-t3-medium text-foreground">
                {name(to, message.toAssistantId)} replied
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {new Date(reply.at).toLocaleString()}
              </Text>
            </View>
            <FoldedMarkdown markdown={reply.text} label="reply" />
          </>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${to?.name ?? "thread"}`}
        onPress={() => flows.openConversation({ threadId: message.toThreadId })}
        className="self-start active:opacity-70"
      >
        <Text textRole="footnote" className="text-foreground-muted">
          Open thread
        </Text>
      </Pressable>
    </View>
  );
}

function Activity(props: { readonly environmentId: EnvironmentId; readonly team: AssistantTeam }) {
  const insets = useSafeAreaInsets();
  const { active, archived } = useAssistantEntries();
  const assistants = new Map(
    [...active, ...archived]
      .filter((entry) => entry.environmentId === props.environmentId)
      .map((entry) => [entry.assistant.id as string, entry.assistant]),
  );
  const query = useAssistantTeamActivity(props.environmentId, props.team.id);
  const { refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server while the screen is open
  useEffect(() => {
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const messages = query.data?.messages ?? [];
  return (
    <SettingsScreen title={props.team.name}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {teamSummary(props.team, [...assistants.values()])}. Messages members sent each other and
          their replies, oldest first.
        </Text>
        {query.data !== null && messages.length === 0 ? (
          <EmptyState
            variant="plain"
            title="No messages yet"
            detail="They show up here when teammates talk to each other."
          />
        ) : (
          messages.map((message) => (
            <MessageRow
              key={message.messageId}
              environmentId={props.environmentId}
              message={message}
              team={props.team}
              assistants={assistants}
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
