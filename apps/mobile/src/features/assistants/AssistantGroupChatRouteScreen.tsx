import {
  applyAssistantGroupHistory,
  assistantGroupAuthorName,
  assistantGroupAwaitingRoute,
  assistantGroupFeed,
  assistantGroupRunningCount,
  type AssistantGroupChatState,
  type AssistantGroupFeedRow,
} from "@t3tools/client-runtime/assistantGroupChat";
import { teamSummary } from "@t3tools/client-runtime/assistantTeam";
import {
  AssistantTeamId,
  EnvironmentId,
  ThreadId,
  type Assistant,
  type AssistantGroupMessage,
  type AssistantGroupsHistoryResult,
  type AssistantGroupTask,
  type AssistantGroupTaskAction,
} from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import {
  useAssistantEntries,
  useAssistantGroupActions,
  useAssistantGroupChat,
} from "../../state/assistants";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { MENTION_REQUIRED_COPY, GroupComposer, type GroupSendResult } from "./GroupComposer";
import { GroupTaskCard } from "./GroupTaskCard";
import { AssistantAvatar } from "./assistantPresentation";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useAssistantTeamFlows } from "./useAssistantFlows";
import { useScheduleInGroup } from "./useScheduleInGroup";

const MENTION_TOKEN = /(@[\p{L}\p{N}_-]+)/u;

/** The text with each `@mention` picked out, as the user typed it. */
function MentionText(props: { readonly text: string }) {
  const parts = props.text.split(MENTION_TOKEN);
  return (
    <Text className="text-base text-foreground">
      {parts.map((part, index) => {
        const mention = index % 2 === 1;
        // An empty part shares its offset with the mention after it, so the kind joins the key.
        const key = `${parts.slice(0, index).join("").length}${mention ? "m" : "t"}`;
        return (
          <Text key={key} className={mention ? "font-t3-bold text-primary-text" : undefined}>
            {part}
          </Text>
        );
      })}
    </Text>
  );
}

type TaskHandlers = {
  readonly members: ReadonlyArray<Assistant>;
  readonly canAct: boolean;
  readonly onTaskAction: (
    task: AssistantGroupTask,
    action: AssistantGroupTaskAction,
    ownerId?: Assistant["id"],
  ) => void;
  readonly onOpenConversation: (task: AssistantGroupTask) => void;
};

function TaskCards(
  props: TaskHandlers & {
    readonly tasks: ReadonlyArray<AssistantGroupTask>;
    readonly showOwner: boolean;
  },
) {
  return props.tasks.map((task) => (
    <GroupTaskCard
      key={task.id}
      task={task}
      ownerName={
        props.showOwner
          ? props.members.find((member) => member.id === task.ownerId)?.name
          : undefined
      }
      reassignTo={props.members.filter((member) => member.id !== task.ownerId)}
      canAct={props.canAct}
      onAction={(action, ownerId) => props.onTaskAction(task, action, ownerId)}
      onOpenConversation={() => props.onOpenConversation(task)}
    />
  ));
}

function FeedRow(
  props: TaskHandlers & {
    readonly environmentId: EnvironmentId;
    readonly row: AssistantGroupFeedRow;
    readonly chat: AssistantGroupChatState;
    readonly assistants: ReadonlyMap<string, Assistant>;
    readonly lead: Assistant | undefined;
    readonly archived: boolean;
    readonly onReply: (message: AssistantGroupMessage, name: string) => void;
  },
) {
  const { message } = props.row;
  const styles = useMarkdownPreviewStyles();
  const author =
    message.assistantId === null ? undefined : props.assistants.get(message.assistantId);
  const cards = (
    <TaskCards {...props} tasks={props.row.tasks} showOwner={props.row.role !== "answer"} />
  );
  if (props.row.role === "note") {
    return (
      <View testID="group-note" className="items-center gap-1 px-4 py-1.5">
        <Text className="text-center text-xs text-foreground-muted">{message.text}</Text>
        {cards}
      </View>
    );
  }
  if (props.row.role === "request") {
    const fromUser = message.author === "user";
    const replyTarget =
      message.replyToMessageId === null
        ? undefined
        : props.chat.messages.get(message.replyToMessageId);
    const repliedTo =
      replyTarget?.assistantId == null
        ? undefined
        : props.assistants.get(replyTarget.assistantId)?.name;
    const label =
      message.authorLabel ?? author?.name ?? (message.author === "routine" ? "Schedule" : "Agent");
    return (
      <View
        testID="group-request"
        className={cn("gap-1 px-4 py-1.5", fromUser ? "items-end" : "items-start")}
      >
        {fromUser ? null : <Text className="text-xs text-foreground-muted">{label}</Text>}
        {repliedTo === undefined ? null : (
          <Text className="text-xs text-foreground-muted">Reply to {repliedTo}</Text>
        )}
        <View className="max-w-[85%] rounded-2xl bg-subtle-strong px-3 py-2">
          <MentionText text={message.text} />
        </View>
        {assistantGroupAwaitingRoute(props.chat, message) ? (
          <Text testID="group-routing" className="text-xs text-foreground-muted">
            {props.lead === undefined
              ? "Waiting for someone to take it…"
              : `${props.lead.name} (lead) is choosing who answers…`}
          </Text>
        ) : null}
        {cards}
      </View>
    );
  }
  const replyTarget =
    message.replyToMessageId === null
      ? undefined
      : props.chat.messages.get(message.replyToMessageId);
  const name = author?.name ?? "Assistant";
  const reply = () => props.onReply(message, name);
  return (
    <View testID="group-answer" className="flex-row items-start gap-2.5 px-4 py-1.5">
      <View className="size-7">
        {author === undefined ? null : (
          <AssistantAvatar assistant={author} environmentId={props.environmentId} size={28} />
        )}
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-1.5">
          <Text className="shrink text-xs font-t3-bold text-foreground" numberOfLines={1}>
            {name}
          </Text>
          {author === undefined || author.role === "" ? null : (
            <View className="max-w-24 rounded-md border border-border px-1.5 py-px">
              <Text
                testID="group-role"
                className="text-2xs text-foreground-muted"
                numberOfLines={1}
              >
                {author.role}
              </Text>
            </View>
          )}
        </View>
        {replyTarget === undefined ? null : (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            In reply to{" "}
            {assistantGroupAuthorName(replyTarget, (id) => props.assistants.get(id)?.name)}
          </Text>
        )}
        <Menu
          shouldOpenOnLongPress
          actions={[
            {
              id: "reply",
              title: "Reply",
              image: "arrowshape.turn.up.left",
              attributes: { disabled: props.archived },
            },
          ]}
          onPressAction={() => reply()}
        >
          <Pressable accessibilityLabel={`Message from ${name}`}>
            <SelectableMarkdownText markdown={message.text} textStyle={styles.nativeTextStyle} />
          </Pressable>
        </Menu>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Reply to ${name}`}
          disabled={props.archived}
          hitSlop={6}
          onPress={reply}
          className="self-start py-1 active:opacity-70 disabled:opacity-40"
        >
          <Text className="text-xs font-t3-medium text-foreground-secondary">Reply</Text>
        </Pressable>
        {cards}
      </View>
    </View>
  );
}

export function AssistantGroupChatRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: string; readonly teamId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const teamId = AssistantTeamId.make(route.params.teamId);
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const entries = useAssistantEntries();
  const live = useAssistantGroupChat(environmentId, teamId);
  const actions = useAssistantGroupActions(environmentId);
  const flows = useAssistantTeamFlows(environmentId);
  const openTeam = useOpenAssistantTeam();
  const openEditor = useOpenAssistantEditor();
  const scheduleInGroup = useScheduleInGroup();
  const [pages, setPages] = useState<ReadonlyArray<AssistantGroupsHistoryResult>>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState<{
    readonly id: AssistantGroupMessage["id"];
    readonly name: string;
  } | null>(null);
  const list = useRef<LegendListRef>(null);

  const team = entries.teams.find(
    (entry) => entry.environmentId === environmentId && entry.team.id === teamId,
  )?.team;
  const everyone = [...entries.active, ...entries.archived]
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.assistant);
  const byId = new Map<string, Assistant>(everyone.map((assistant) => [assistant.id, assistant]));
  const members = (team?.memberIds ?? []).flatMap((id) => {
    const member = byId.get(id);
    return member === undefined || member.archivedAt !== null ? [] : [member];
  });
  const chat =
    live === null
      ? null
      : pages.reduce((state, page) => applyAssistantGroupHistory(state, page), live);
  const rows = chat === null ? [] : assistantGroupFeed(chat);
  const archived = team?.archivedAt != null;
  const lead = members.find((member) => member.id === team?.leadId);

  const loadOlder = async () => {
    if (chat === null || !chat.hasMore || loadingOlder) return;
    setLoadingOlder(true);
    const reply = await actions.olderThan(teamId, chat);
    setLoadingOlder(false);
    if (!reply.ok) return Dialog.alert("Could not load earlier messages", reply.message);
    setPages((current) => [...current, reply.value]);
  };

  const send = async (text: string): Promise<GroupSendResult> => {
    const reply = await actions.post({
      teamId,
      text,
      ...(replyTo === null ? {} : { replyToMessageId: replyTo.id }),
    });
    if (reply.ok) {
      setReplyTo(null);
      list.current?.scrollToEnd({ animated: true });
      return { ok: true };
    }
    return {
      ok: false,
      message:
        reply.reason === "mention_required"
          ? MENTION_REQUIRED_COPY
          : reply.reason === "archived"
            ? "This group is archived. Restore it to write here."
            : reply.message,
    };
  };

  const taskAction = async (
    task: AssistantGroupTask,
    action: AssistantGroupTaskAction,
    ownerId?: Assistant["id"],
  ) => {
    const reply = await actions.taskAction({
      taskId: task.id,
      action,
      ...(ownerId === undefined ? {} : { ownerId }),
    });
    if (!reply.ok) Dialog.alert("Could not update the task", reply.message);
  };

  const openConversation = (task: AssistantGroupTask) => {
    const params = {
      environmentId: String(environmentId),
      threadId: ThreadId.make(task.threadId),
    };
    if (Platform.OS === "android") selectDetail({ name: "Thread", params });
    else navigation.dispatch(StackActions.push("Thread", params));
  };

  if (team === undefined) {
    return (
      <View className="flex-1 bg-screen">
        <AppBar title="Group chat" onBack={() => navigation.goBack()} sidebar={false} />
        {entries.environmentIds.includes(environmentId) ? (
          <EmptyState title="Group not found" detail="It may have been deleted." variant="plain" />
        ) : null}
      </View>
    );
  }

  const running = chat === null ? 0 : assistantGroupRunningCount(chat);
  return (
    <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
      <AppBar
        title={team.name}
        subtitle={[teamSummary(team, everyone), running > 0 ? `${running} running` : null]
          .filter((part) => part !== null)
          .join(" · ")}
        onBack={() => navigation.goBack()}
        sidebar={false}
        menus={[
          {
            title: `${team.name} actions`,
            icon: "ellipsis",
            items: [
              {
                id: "edit",
                title: "Edit group",
                icon: "pencil",
                onPress: () => openTeam.edit(environmentId, team.id),
              },
              {
                id: "new",
                title: "New assistant in this group",
                icon: "plus",
                onPress: () => openEditor(environmentId, null, { teamId: team.id }),
              },
              {
                id: "schedule",
                title: "Schedule in this group",
                icon: "calendar.badge.clock",
                onPress: () => scheduleInGroup(environmentId, team.id),
              },
              archived
                ? {
                    id: "restore",
                    title: "Restore group",
                    icon: "arrow.uturn.backward",
                    disabled: !flows.canAct,
                    onPress: () => void flows.restore(team),
                  }
                : {
                    id: "archive",
                    title: "Archive group",
                    icon: "archivebox",
                    disabled: !flows.canAct,
                    onPress: () => flows.archive(team),
                  },
            ],
          },
        ]}
      />
      <LegendList
        ref={list}
        renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
        className="flex-1"
        data={rows}
        extraData={chat}
        estimatedItemSize={72}
        keyExtractor={(row) => row.message.id}
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainVisibleContentPosition
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onStartReached={() => void loadOlder()}
        ListHeaderComponent={
          chat?.hasMore ? (
            <View className="items-center py-2">
              <Button
                label="Load earlier messages"
                size="compact"
                tone="text"
                disabled={loadingOlder}
                onPress={() => void loadOlder()}
              />
            </View>
          ) : null
        }
        ListEmptyComponent={
          chat === null ? null : (
            <EmptyState
              variant="plain"
              title="No messages yet"
              detail={
                members.length === 0
                  ? "Add assistants to this group in Edit group, then write here."
                  : `${members.map((member) => member.name).join(", ")} ${members.length === 1 ? "is" : "are"} in this group. Start with @${members[0]!.handle} to give one a task, @everyone for all of them${lead === undefined ? "" : `, or write without @ and ${lead.name} routes it`}.`
              }
            />
          )
        }
        renderItem={({ item }) => (
          <FeedRow
            environmentId={environmentId}
            row={item}
            chat={chat!}
            assistants={byId}
            members={members}
            lead={lead}
            canAct={actions.canAct}
            archived={archived}
            onReply={(message, name) => setReplyTo({ id: message.id, name })}
            onTaskAction={(task, action, ownerId) => void taskAction(task, action, ownerId)}
            onOpenConversation={openConversation}
          />
        )}
      />
      {archived ? (
        <View
          accessibilityRole="alert"
          className="flex-row items-center gap-2 border-y border-border px-4 py-1.5"
        >
          <Text className="min-w-0 flex-1 text-xs text-foreground">Archived · no new messages</Text>
          <Button
            label="Restore"
            size="compact"
            disabled={!flows.canAct}
            onPress={() => void flows.restore(team)}
          />
        </View>
      ) : null}
      <GroupComposer
        environmentId={environmentId}
        members={members}
        leadId={team.leadId}
        disabled={archived || !actions.canPost}
        disabledReason={archived ? "Restore the group to write here" : null}
        replyingTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onSend={send}
      />
    </KeyboardAvoidingView>
  );
}
