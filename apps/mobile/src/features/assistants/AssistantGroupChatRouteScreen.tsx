import {
  ASSISTANT_GROUP_REQUEST_STATUS_LABEL,
  applyAssistantGroupHistory,
  assistantGroupAuthorName,
  assistantGroupAwaitingRoute,
  assistantGroupInScope,
  assistantGroupMarkdownMentions,
  assistantGroupRequestExpanded,
  assistantGroupRequestFeed,
  assistantGroupRequestProject,
  assistantGroupMentionHref,
  assistantGroupBoundaryLabel,
  assistantGroupLatestSeq,
  assistantGroupNewSeq,
  assistantGroupAllReadSeq,
  assistantGroupRunningCount,
  assistantGroupTabAfterSend,
  assistantGroupComposerProjects,
  assistantGroupComposerProject,
  assistantGroupTabPick,
  assistantGroupProjectLabel,
  type AssistantGroupProjectPick,
  assistantGroupTabView,
  type AssistantGroupChatState,
  type AssistantGroupTab,
  type AssistantGroupFeedRow,
  type AssistantGroupRequestBlock,
  type AssistantGroupRequestStatus,
  assistantGroupMessageExcerpt,
  assistantGroupWorkedLabel,
  assistantGroupActivity,
  assistantGroupAnswerRoot,
} from "@t3tools/client-runtime/assistantGroupChat";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isLongMessage } from "@t3tools/client-runtime/messageFold";
import { buildAssistantGroupDeepLink } from "@t3tools/shared/agentAwareness";
import { teamModelLayer } from "@t3tools/shared/modelSelectionPrecedence";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { teamSummary } from "@t3tools/client-runtime/assistantTeam";
import {
  AssistantTeamId,
  EnvironmentId,
  ThreadId,
  type Assistant,
  type AssistantTeam,
  type AssistantGroupMessage,
  type AssistantGroupsHistoryResult,
  type AssistantGroupTask,
  type AssistantGroupTaskAction,
  type ChatAttachment,
  type ProjectId,
  assistantGroupInstructionBody,
  assistantGroupProjectIds,
  splitAssistantTransferText,
} from "@t3tools/contracts";
import { useAtom } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { Keyboard, Platform, Pressable, View, useWindowDimensions } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { useReducedMotion, withTiming } from "react-native-reanimated";

import { FoldableContent } from "../../components/FoldableContent";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { VideoPreviewModal } from "../../components/ui/VideoPreviewModal";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { deriveThreadWorkLogSizing } from "../../lib/layout";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { contextChipIconSource } from "../../lib/contextChipIconSource";
import {
  composerGroupMentions,
  groupMentionLinkChip,
  type ComposerGroupMentions,
} from "../../lib/groupMentionChips";
import { useAssistantFaceImages } from "../../native/ChipIconImages";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import {
  SelectableMarkdownText,
  type MarkdownLinkCustomization,
} from "../../native/SelectableMarkdownText";
import {
  useAssistantEntries,
  useAssistantGroupActions,
  useAssistantGroupChat,
} from "../../state/assistants";
import { useDecisionEntries } from "../../state/decisions";
import { useProject, useProjects, useQuietThreadShell } from "../../state/entities";
import { DecisionCard } from "../decisions/DecisionCard";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  AssistantMarkdownContent,
  type MarkdownLinkHandlers,
  type MarkdownStyleSet,
} from "../threads/AssistantMarkdownContent";
import { ASSISTANT_FOLDED_HEIGHT } from "../threads/assistantMessageFold";
import { TaskEventActivityRow } from "../threads/TaskEventActivityRow";
import { useMarkdownStyles } from "../threads/ThreadFeed";
import {
  useMarkdownLinkHost,
  useMarkdownLinks,
  type MarkdownLinkContext,
} from "../threads/useThreadMarkdownLinks";
import { WorkedForFold } from "../threads/WorkedForFold";
import { GroupMessageAttachments } from "./GroupAttachments";
import {
  GroupComposer,
  type GroupComposerProject,
  type GroupReplyTarget,
  type GroupSendResult,
} from "./GroupComposer";
import { GroupProjectTabs } from "./GroupProjectTabs";
import { groupMessageModelAtom } from "./GroupMessageModelPickerRouteScreen";
import { useGroupProjectModel } from "./useGroupProjectModel";
import { GroupStatusLabel, GroupTaskCard, type GroupStatusTone } from "./GroupTaskCard";
import { AssistantAvatar } from "./assistantPresentation";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useAssistantTeamFlows } from "./useAssistantFlows";
import { useGroupReadMarker } from "./useGroupReadMarker";
import { useGroupTabPreference } from "./useGroupTabPreference";
import { showAgentNotificationGroupTab } from "../agent-awareness/notificationNavigation";

type LinkHost = Parameters<typeof useMarkdownLinks>[0];

/** Member and project mentions as their own chips: face or folder, and the name. */
const mentionChip = (
  href: string,
  mentions: ComposerGroupMentions,
): MarkdownLinkCustomization | undefined => {
  const chip = groupMentionLinkChip(href, mentions);
  return chip === null
    ? undefined
    : {
        label: chip.label,
        icon: chip.iconUri === undefined ? contextChipIconSource(chip.icon) : { uri: chip.iconUri },
        chip: { accent: chip.accent, tintsIcon: chip.iconUri === undefined },
      };
};

const NEW_JUMP_MIN_ROWS = 4;
const HIGHLIGHT_MS = 1200;

/** One line of a message, for a quote. */
const groupMessageExcerpt = (text: string) =>
  assistantGroupMessageExcerpt(splitAssistantTransferText(text).body);

const highlightFade = () => {
  "worklet";
  return {
    initialValues: { opacity: 1 },
    animations: { opacity: withTiming(0, { duration: HIGHLIGHT_MS }) },
  };
};

/** The tint a message jumped to wears once; with reduced motion it stays still until cleared. */
function JumpHighlight() {
  const reduced = useReducedMotion();
  return (
    <Animated.View
      testID="group-jump-highlight"
      pointerEvents="none"
      entering={reduced ? undefined : highlightFade}
      className="absolute inset-0 bg-primary/12"
    />
  );
}

/** The thread's markdown, with links opened in the message's own context and mentions as chips. */
function GroupMarkdown(props: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly members: ReadonlyArray<Assistant>;
  readonly projects: ReadonlyArray<GroupComposerProject>;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHost: LinkHost;
  readonly context: MarkdownLinkContext;
  readonly preserveSoftBreaks: boolean;
}) {
  const mentions = composerGroupMentions(
    props.members,
    props.projects,
    useAssistantFaceImages(props.members),
  );
  const links = useMarkdownLinks(props.linkHost, props.context);
  const isMention = (href: string) => assistantGroupMentionHref(href) !== null;
  const linkHandlers: MarkdownLinkHandlers = {
    ...links.linkHandlers,
    // A mention is a highlight only.
    onLinkPress: (href) => {
      if (!isMention(href)) links.linkHandlers.onLinkPress(href);
    },
    fileContextMenu: (href) =>
      isMention(href) ? undefined : links.linkHandlers.fileContextMenu(href),
    linkCustomization: (href) =>
      mentionChip(href, mentions) ?? links.linkHandlers.linkCustomization?.(href),
  };
  return (
    <AssistantMarkdownContent
      markdown={assistantGroupMarkdownMentions(props.text, props.members, props.projects)}
      environmentId={props.environmentId}
      markdownStyles={props.markdownStyles}
      linkHandlers={linkHandlers}
      renderImage={links.renderImage}
      preserveSoftBreaks={props.preserveSoftBreaks}
    />
  );
}

/** Above a reply: who it answers and a line of what they said; tapping shows the original. */
function QuotedLine(props: {
  readonly name: string;
  readonly excerpt: string;
  readonly align: "start" | "end";
  readonly onPress: (() => void) | null;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show the message from ${props.name}`}
      disabled={props.onPress === null}
      onPress={props.onPress ?? undefined}
      hitSlop={4}
      className={cn(
        "max-w-[85%] flex-row items-center gap-1.5 active:opacity-70",
        props.align === "end" ? "self-end" : "self-start",
      )}
    >
      <SymbolView
        name="arrowshape.turn.up.left"
        size={11}
        tintColorClassName="accent-icon-subtle"
      />
      <Text
        testID="group-quoted-line"
        className="shrink text-xs text-foreground-muted"
        numberOfLines={1}
      >
        <Text className="font-t3-medium text-foreground-secondary">{props.name}</Text>
        {props.excerpt === "" ? "" : `  ${props.excerpt}`}
      </Text>
    </Pressable>
  );
}

function NewDivider() {
  return (
    <View
      accessibilityRole="none"
      accessibilityLabel="New messages"
      testID="group-new-divider"
      className="flex-row items-center gap-2 px-4 py-1.5"
    >
      <View className="h-px flex-1 bg-primary/40" />
      <Text className="text-xs font-t3-medium text-primary-text">New</Text>
      <View className="h-px flex-1 bg-primary/40" />
    </View>
  );
}

/** The notice text is the question, then its context, then "Options: a · b". */
function waitingParts(text: string) {
  const parts = text.split(/\n{2,}/).map((part) => part.trim());
  const optionsAt = parts.findIndex((part) => part.startsWith("Options: "));
  const options =
    optionsAt < 0 ? [] : parts[optionsAt]!.slice("Options: ".length).split(" · ").filter(Boolean);
  const rest = parts.filter((part, index) => index !== optionsAt && part !== "");
  return { title: rest[0] ?? "", context: rest.slice(1).join("\n\n"), options };
}

/** A member's conversation for the request waits on the user: say what, and where to answer. */
function WaitingNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly message: AssistantGroupMessage;
  readonly waiting: NonNullable<AssistantGroupMessage["waiting"]>;
  readonly name: string;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { waiting } = props;
  const [showDecision, setShowDecision] = useState(false);
  const { open, settled } = useDecisionEntries();
  const decision =
    waiting.decisionId === undefined
      ? undefined
      : [...open, ...settled].find(
          (entry) =>
            entry.environmentId === props.environmentId && entry.decision.id === waiting.decisionId,
        );
  const parts = waitingParts(props.message.text);
  if (waiting.resolved) {
    return (
      <View
        testID="group-waiting"
        className="mx-4 my-1 flex-row items-center gap-1.5 rounded-xl border border-foreground/10 px-3 py-2"
      >
        <SymbolView name="checkmark.circle" size={13} tintColorClassName="accent-icon-subtle" />
        <Text className="text-xs font-t3-medium text-foreground-secondary">{props.name} asked</Text>
        <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
          {parts.title}
        </Text>
        <Text testID="group-waiting-resolved" className="ml-auto text-xs text-foreground-muted">
          Resolved
        </Text>
      </View>
    );
  }
  return (
    <View
      testID="group-waiting"
      className="mx-4 my-1.5 gap-2 rounded-2xl border border-warning-border bg-warning px-3.5 py-3"
    >
      <View className="flex-row items-center gap-1.5">
        <SymbolView name="hourglass" size={13} tintColorClassName="accent-warning-foreground" />
        <Text className="shrink text-xs font-t3-medium text-warning-foreground" numberOfLines={1}>
          {props.name} is waiting on you
        </Text>
      </View>
      {parts.title === "" ? null : (
        <Text className="text-sm font-t3-bold text-foreground">{parts.title}</Text>
      )}
      {parts.context === "" ? null : (
        <Text className="text-xs text-foreground-secondary">{parts.context}</Text>
      )}
      {parts.options.length === 0 ? null : (
        <View testID="group-waiting-options" className="flex-row flex-wrap gap-1.5">
          {parts.options.map((option) => (
            <View key={option} className="rounded-full bg-foreground/8 px-2.5 py-1">
              <Text className="text-xs text-foreground">{option}</Text>
            </View>
          ))}
        </View>
      )}
      <View className="flex-row flex-wrap gap-2 pt-0.5">
        <Button
          label="Open conversation"
          size="compact"
          tone="primary"
          onPress={() => props.onOpenThread(waiting.threadId)}
        />
        {decision === undefined ? null : (
          <Button
            label={showDecision ? "Hide decision" : "Open decision"}
            size="compact"
            onPress={() => setShowDecision((shown) => !shown)}
          />
        )}
      </View>
      {showDecision && decision !== undefined ? (
        <DecisionCard
          environmentId={decision.environmentId}
          decision={decision.decision}
          onOpenThread={() => props.onOpenThread(waiting.threadId)}
        />
      ) : null}
    </View>
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

/** A finished task as the thread's activity line, titled by its member thread when known. */
function GroupTaskLine(props: {
  readonly environmentId: EnvironmentId;
  readonly task: AssistantGroupTask;
  readonly onOpen: () => void;
}) {
  const shell = useQuietThreadShell(scopeThreadRef(props.environmentId, props.task.threadId));
  return (
    <TaskEventActivityRow
      {...assistantGroupActivity(props.task.status, {
        threadTitle: shell?.title,
        instruction: props.task.instruction,
      })}
      onOpen={props.onOpen}
    />
  );
}

function TaskCards(
  props: TaskHandlers & {
    readonly environmentId: EnvironmentId;
    readonly tasks: ReadonlyArray<AssistantGroupTask>;
    readonly showOwner: boolean;
  },
) {
  return props.tasks.map((task) =>
    task.status === "completed" || task.status === "cancelled" ? (
      <GroupTaskLine
        key={task.id}
        environmentId={props.environmentId}
        task={task}
        onOpen={() => props.onOpenConversation(task)}
      />
    ) : (
      <GroupTaskCard
        key={task.id}
        task={task}
        environmentId={props.environmentId}
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
    ),
  );
}

function FeedRow(
  props: TaskHandlers & {
    readonly environmentId: EnvironmentId;
    readonly row: AssistantGroupFeedRow;
    readonly chat: AssistantGroupChatState;
    readonly assistants: ReadonlyMap<string, Assistant>;
    readonly projects: ReadonlyArray<GroupComposerProject>;
    readonly lead: Assistant | undefined;
    readonly archived: boolean;
    readonly onReply: (message: AssistantGroupMessage, name: string) => void;
    readonly onJump: (messageId: AssistantGroupMessage["id"]) => void;
    readonly onPreview: (source: FilePreviewSource) => void;
    readonly onOpenThread: (threadId: ThreadId) => void;
    readonly linkHost: LinkHost;
    /** The root of the request's project, for the message's file links. */
    readonly workspaceRoot: string | null;
  },
) {
  const { message } = props.row;
  const styles = useMarkdownStyles();
  const { appearance } = useAppearancePreferences();
  const { fontScale } = useWindowDimensions();
  const rowSizing = deriveThreadWorkLogSizing({ baseFontSize: appearance.baseFontSize, fontScale });
  const iconColor = useUniwindTheme()["--color-icon-subtle"];
  const [workedOpen, setWorkedOpen] = useState(false);
  const author =
    message.assistantId === null ? undefined : props.assistants.get(message.assistantId);
  const answered = message.taskId === null ? undefined : props.chat.tasks.get(message.taskId);
  const answeredShell = useQuietThreadShell(
    answered === undefined ? null : scopeThreadRef(props.environmentId, answered.threadId),
  );
  const answeredProject = useProject(
    answeredShell === null ? null : scopeProjectRef(props.environmentId, answeredShell.projectId),
  );
  const cards = (
    <TaskCards {...props} tasks={props.row.tasks} showOwner={props.row.role !== "answer"} />
  );
  const replyTarget =
    message.replyToMessageId === null
      ? undefined
      : props.chat.messages.get(message.replyToMessageId);
  const quoted = (align: "start" | "end") =>
    replyTarget === undefined ? null : (
      <QuotedLine
        name={assistantGroupAuthorName(replyTarget, (id) => props.assistants.get(id)?.name)}
        excerpt={groupMessageExcerpt(replyTarget.text)}
        align={align}
        onPress={() => props.onJump(replyTarget.id)}
      />
    );
  if (props.row.role === "boundary") {
    return (
      <View
        accessibilityRole="none"
        accessibilityLabel={assistantGroupBoundaryLabel(message)}
        testID="group-boundary"
        className="flex-row items-center gap-2 px-4 py-1.5"
      >
        <View className="h-px flex-1 bg-foreground/10" />
        <Text className="text-xs font-t3-medium text-foreground-muted">
          {assistantGroupBoundaryLabel(message)}
        </Text>
        <View className="h-px flex-1 bg-foreground/10" />
      </View>
    );
  }
  if (props.row.role === "note" && message.waiting !== undefined) {
    return (
      <>
        <WaitingNotice
          environmentId={props.environmentId}
          message={message}
          waiting={message.waiting}
          name={author?.name ?? "A member"}
          onOpenThread={props.onOpenThread}
        />
        <View className="px-4">{cards}</View>
      </>
    );
  }
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
    const parts = splitAssistantTransferText(message.text);
    const label =
      message.authorLabel ?? author?.name ?? (message.author === "routine" ? "Schedule" : "Agent");
    return (
      <View
        testID="group-request"
        className={cn("gap-1 px-4 py-1.5", fromUser ? "items-end" : "items-start")}
      >
        {fromUser ? null : (
          <Text className="text-xs font-t3-medium text-foreground-secondary">{label}</Text>
        )}
        {quoted(fromUser ? "end" : "start")}
        <View
          className={cn(
            "max-w-[85%] rounded-[20px] px-3.5 py-2.5",
            fromUser ? "bg-user-bubble" : "bg-foreground/6",
          )}
        >
          <GroupMarkdown
            environmentId={props.environmentId}
            text={parts.body}
            members={props.members}
            projects={props.projects}
            markdownStyles={fromUser ? styles.user : styles.assistant}
            linkHost={props.linkHost}
            context={{ threadId: null, workspaceRoot: props.workspaceRoot }}
            preserveSoftBreaks
          />
          {parts.files === null ? null : (
            <View testID="group-request-files" className="mt-1.5">
              <SelectableMarkdownText
                markdown={parts.files}
                textStyle={(fromUser ? styles.user : styles.assistant).nativeTextStyle}
              />
            </View>
          )}
        </View>
        <GroupMessageAttachments
          environmentId={props.environmentId}
          attachments={message.attachments ?? []}
          onPreview={props.onPreview}
        />
        {assistantGroupAwaitingRoute(props.chat, message) ? (
          <Text testID="group-routing" className="text-xs text-foreground-muted">
            {props.lead === undefined
              ? "Waiting for a lead to route it. Set one in Edit group."
              : `${props.lead.name} (lead) is choosing who answers…`}
          </Text>
        ) : null}
        {cards}
      </View>
    );
  }
  const name = author?.name ?? "Assistant";
  const reply = () => props.onReply(message, name);
  return (
    <View testID="group-answer" className="flex-row items-start gap-2.5 px-4 py-2">
      <View className="size-7">
        {author === undefined ? null : (
          <AssistantAvatar assistant={author} environmentId={props.environmentId} size={28} />
        )}
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-1.5">
          <Text className="shrink text-sm font-t3-bold text-foreground" numberOfLines={1}>
            {name}
          </Text>
          {author === undefined || author.role === "" ? null : (
            <View className="max-w-28 rounded-full bg-foreground/6 px-2 py-px">
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
        {quoted("start")}
        {answered === undefined ? null : (
          <View className="flex-row items-center">
            <WorkedForFold
              label={assistantGroupWorkedLabel(message)}
              expanded={workedOpen}
              loading={false}
              error={null}
              onToggle={() => setWorkedOpen((open) => !open)}
              rowSizing={rowSizing}
              iconColor={iconColor}
            >
              <Text
                testID="group-worked-instruction"
                className="pb-2 text-sm text-foreground-muted"
              >
                {assistantGroupInstructionBody(answered.instruction)}
              </Text>
            </WorkedForFold>
          </View>
        )}
        <FoldableContent
          foldable={isLongMessage(message.text)}
          foldedHeight={ASSISTANT_FOLDED_HEIGHT}
        >
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
              <GroupMarkdown
                environmentId={props.environmentId}
                text={message.text}
                members={props.members}
                projects={props.projects}
                markdownStyles={styles.assistant}
                linkHost={props.linkHost}
                context={{
                  threadId: answered?.threadId ?? null,
                  workspaceRoot: assistantGroupAnswerRoot({
                    thread:
                      answeredShell === null
                        ? null
                        : {
                            worktreePath: answeredShell.worktreePath,
                            projectRoot: answeredProject?.workspaceRoot,
                          },
                    requestRoot: props.workspaceRoot,
                  }),
                }}
                preserveSoftBreaks={shouldPreserveAssistantLineBreaks(message.text)}
              />
            </Pressable>
          </Menu>
        </FoldableContent>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Reply to ${name}`}
          disabled={props.archived}
          hitSlop={6}
          onPress={reply}
          className="flex-row items-center gap-1 self-start py-1 active:opacity-70 disabled:opacity-40"
        >
          <SymbolView
            name="arrowshape.turn.up.left"
            size={11}
            tintColorClassName="accent-icon-subtle"
          />
          <Text className="text-xs font-t3-medium text-foreground-secondary">Reply</Text>
        </Pressable>
        {cards}
      </View>
    </View>
  );
}

const REQUEST_STATUS_TONE: Record<AssistantGroupRequestStatus, GroupStatusTone> = {
  routing: "active",
  "needs-project": "attention",
  working: "active",
  "needs-you": "attention",
  done: "done",
  cancelled: "quiet",
};

/** A request's title row: tapping it folds or opens the request. */
function RequestHeader(props: {
  readonly block: AssistantGroupRequestBlock;
  readonly projectName: string | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const { block } = props;
  if (!props.expanded) {
    const activity = assistantGroupActivity(block.status);
    return (
      <View testID="group-request-line" className="mx-3 mt-4">
        <TaskEventActivityRow
          title={block.title}
          status={activity.status}
          label={
            props.projectName === null ? activity.label : `${activity.label} · ${props.projectName}`
          }
          onOpen={props.onToggle}
          action="Open request"
        />
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Request ${block.title}`}
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onToggle}
      className="mx-3 mt-4 flex-row items-center gap-2.5 rounded-2xl border border-foreground/10 bg-foreground/4 px-3 py-2.5 active:bg-foreground/8"
    >
      <SymbolView
        name={props.expanded ? "chevron.down" : "chevron.right"}
        size={11}
        tintColorClassName="accent-icon-subtle"
      />
      <View className="min-w-0 flex-1 gap-1">
        <Text
          testID="group-request-title"
          className="text-sm font-t3-bold text-foreground"
          numberOfLines={1}
        >
          {block.title}
        </Text>
        <View className="flex-row items-center gap-3">
          <GroupStatusLabel
            testID="group-request-status"
            tone={REQUEST_STATUS_TONE[block.status]}
            label={ASSISTANT_GROUP_REQUEST_STATUS_LABEL[block.status]}
          />
          {props.projectName === null ? null : (
            <View className="min-w-0 shrink flex-row items-center gap-1">
              <SymbolView name="folder" size={11} tintColorClassName="accent-icon-subtle" />
              <Text
                testID="group-request-project"
                className="shrink text-xs text-foreground-muted"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {props.projectName}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

/** In All, every request as one line naming its project; tapping opens it in place. */
function AllRequestLine(props: {
  readonly block: AssistantGroupRequestBlock;
  readonly chip: string | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const activity = assistantGroupActivity(props.block.status);
  return (
    <View testID="group-request-line" className="mx-3 mt-4">
      <TaskEventActivityRow
        title={props.block.title}
        status={activity.status}
        label={activity.label}
        {...(props.chip === null ? {} : { chip: { label: props.chip } })}
        actionLabel={props.expanded ? "Collapse" : "Expand"}
        action={props.expanded ? "Collapse request" : "Expand request"}
        onOpen={props.onToggle}
      />
    </View>
  );
}

function FooterAction(props: {
  readonly icon: "arrowshape.turn.up.left" | "folder";
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-8 flex-row items-center gap-1.5 rounded-full bg-foreground/6 px-3 active:bg-foreground/12 disabled:opacity-40"
    >
      <SymbolView name={props.icon} size={12} tintColorClassName="accent-icon-subtle" />
      <Text className="text-xs font-t3-medium text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** Below an open request: the project choices it waits for, and a reply that stays in it. */
function RequestFooter(props: {
  readonly block: AssistantGroupRequestBlock;
  readonly projects: ReadonlyArray<GroupComposerProject>;
  readonly disabled: boolean;
  readonly onPickProject: (project: GroupComposerProject) => void;
  readonly onReply: () => void;
}) {
  return (
    <View className="gap-2 px-4 pb-1 pt-1.5">
      {props.block.status === "needs-project" && props.projects.length > 0 ? (
        <View testID="group-request-projects" className="gap-1.5">
          <Text className="text-xs text-foreground-muted">Pick a project for this request</Text>
          <View className="flex-row flex-wrap gap-1.5">
            {props.projects.map((project) => (
              <FooterAction
                key={project.id}
                icon="folder"
                label={project.name}
                accessibilityLabel={`Use project ${project.name}`}
                disabled={props.disabled}
                onPress={() => props.onPickProject(project)}
              />
            ))}
          </View>
        </View>
      ) : null}
      <View className="flex-row">
        <FooterAction
          icon="arrowshape.turn.up.left"
          label="Reply to request"
          accessibilityLabel={`Reply to request ${props.block.title}`}
          disabled={props.disabled}
          onPress={props.onReply}
        />
      </View>
    </View>
  );
}

type FeedEntry =
  | {
      readonly kind: "header";
      readonly block: AssistantGroupRequestBlock;
      readonly expanded: boolean;
    }
  | { readonly kind: "row"; readonly row: AssistantGroupFeedRow }
  | { readonly kind: "footer"; readonly block: AssistantGroupRequestBlock };

const entryKey = (entry: FeedEntry) =>
  entry.kind === "row" ? entry.row.message.id : `${entry.kind}:${entry.block.requestId}`;

/**
 * The group's team, people and projects. A hook so the compiler caches them: the screen passes them
 * on to plain functions after its own hooks, which keeps it from caching them there.
 */
function useGroupPeople(environmentId: EnvironmentId, teamId: AssistantTeamId) {
  const entries = useAssistantEntries();
  const projects = useProjects();
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
  const groupProjectIds = assistantGroupProjectIds(members, team?.projectIds ?? []);
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const projectName = (id: ProjectId) =>
    assistantGroupProjectLabel(
      id,
      environmentProjects,
      team?.chat?.scopes,
      groupProjectIds,
      team?.chat?.removedProjectIds,
    );
  const groupProjects: ReadonlyArray<GroupComposerProject> = assistantGroupComposerProjects(
    groupProjectIds,
    environmentProjects,
  ).map((id) => ({ id, name: projectName(id) }));
  return { team, everyone, byId, members, groupProjects, projectName };
}

/** What the screen asks of its feed, which remounts per tab. */
type GroupFeedHandle = {
  readonly jump: (id: AssistantGroupMessage["id"]) => void;
  readonly scrollToEnd: () => void;
};

type GroupReply = GroupReplyTarget & { readonly id: AssistantGroupMessage["id"] };

/**
 * One tab's messages: its own pages, folds, New line and read marker. The screen keys it by tab,
 * so none of that leaks between tabs; the composer stays outside so a draft survives a switch.
 */
function GroupFeed({
  ref,
  ...props
}: {
  readonly ref: Ref<GroupFeedHandle>;
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
  readonly people: ReturnType<typeof useGroupPeople>;
  readonly actions: ReturnType<typeof useAssistantGroupActions>;
  /** null when the group has no tabs: every request, as before tabs. */
  readonly tab: AssistantGroupTab | null;
  readonly live: AssistantGroupChatState | null;
  /** The pinned tab row's height on iOS, added under the bar's own inset. */
  readonly topInset: number | undefined;
  readonly onReply: (target: GroupReply) => void;
}) {
  const { environmentId, team, tab, live, topInset } = props;
  const teamId = team.id;
  const { byId, members, groupProjects, projectName } = props.people;
  const selectDetail = useSelectWorkspaceDetail();
  const markdownStyles = useMarkdownStyles();
  const links = useMarkdownLinkHost({
    environmentId,
    scope: [teamId],
    markdownStyles: markdownStyles.assistant,
  });
  // Rows get only the link builders, which stay the same while a preview opens and closes.
  const linkHost: LinkHost = { linksFor: links.linksFor, imageSources: links.imageSources };
  const { actions } = props;
  const projects = useProjects();
  const [pages, setPages] = useState<ReadonlyArray<AssistantGroupsHistoryResult>>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // A message to bring into view once the list holds it (its request may still be folded).
  const pendingJump = useRef<AssistantGroupMessage["id"] | null>(null);
  const [highlight, setHighlight] = useState<{
    readonly id: AssistantGroupMessage["id"];
    readonly nonce: number;
  } | null>(null);
  const highlightNonce = useRef(0);
  // The user's own fold or open of a request, over the default.
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const list = useRef<LegendListRef>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  // Where the "New" line goes, fixed when the chat first shows: it stays until the user leaves.
  const [newSeq, setNewSeq] = useState<number | null | undefined>(undefined);
  // The read position at open, so requests do not fold away as the chat is marked read.
  const [openReadSeq, setOpenReadSeq] = useState(0);

  const chat =
    live === null
      ? null
      : pages.reduce((state, page) => applyAssistantGroupHistory(state, page), live);
  const archived = team.archivedAt != null;
  const lead = members.find((member) => member.id === team.leadId);
  const scope = tab?.scope;
  // All shows every request folded to a line and moves no read position.
  const isAll = tab?.key === "all";
  const readSeq = tab?.readSeq ?? team.chat?.readSeq ?? 0;
  if (newSeq === undefined && chat !== null) {
    // A server without counters sends none: there is no position to draw a line from.
    setNewSeq(
      team.chat === undefined
        ? null
        : assistantGroupNewSeq(chat, isAll ? assistantGroupAllReadSeq(chat, team.chat) : readSeq),
    );
    setOpenReadSeq(readSeq);
  }

  // A request that left this tab's project (it got one) drops out of it.
  const items = (chat === null ? [] : assistantGroupRequestFeed(chat)).filter(
    (item) => item.kind !== "request" || assistantGroupInScope(item.block, scope),
  );
  const newestRequest = items.findLast((item) => item.kind === "request");
  const feedEntries: FeedEntry[] = items.flatMap((item): FeedEntry[] => {
    if (item.kind === "row") return [item];
    const { block } = item;
    const expanded =
      toggles.get(block.requestId) ??
      (!isAll && assistantGroupRequestExpanded(block, openReadSeq, item === newestRequest));
    if (!expanded) return [{ kind: "header", block, expanded }];
    return [
      { kind: "header", block, expanded },
      ...block.rows.map((row) => ({ kind: "row" as const, row })),
      { kind: "footer", block },
    ];
  });

  // Open on the first unread message when several rows lie below it, else stay at the end.
  const newIndex = feedEntries.findIndex(
    (entry) => entry.kind === "row" && entry.row.message.seq === newSeq,
  );
  const jumpTo =
    newIndex >= 0 && feedEntries.length - newIndex > NEW_JUMP_MIN_ROWS ? newIndex : null;
  useGroupReadMarker({
    latestSeq: chat === null ? null : assistantGroupLatestSeq(chat),
    readSeq,
    // The list opens at the New line when it jumps, so nothing is at the end until the user scrolls.
    atBottom: scrolled ? atBottom : jumpTo === null,
    enabled: team.chat !== undefined && actions.canMarkRead && !isAll,
    markRead: (next) =>
      void actions.markRead(
        teamId,
        scope === undefined ? { readSeq: next } : { readSeq: next, scope },
      ),
  });

  const entryIndexOf = (id: AssistantGroupMessage["id"]) =>
    feedEntries.findIndex((entry) => entry.kind === "row" && entry.row.message.id === id);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list to a quoted message once the request holding it has opened
  useEffect(() => {
    if (pendingJump.current === null) return;
    const index = entryIndexOf(pendingJump.current);
    if (index < 0) return;
    pendingJump.current = null;
    void list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
  });

  /** Brings a quoted message into view and tints it once, opening its request if folded. */
  const jump = (id: AssistantGroupMessage["id"]) => {
    const holder = items.find((item) =>
      item.kind === "request"
        ? item.block.rows.some((row) => row.message.id === id)
        : item.row.message.id === id,
    );
    // A pending jump to a row that never shows would scroll there whenever it later did.
    pendingJump.current = null;
    if (holder === undefined) return;
    if (holder.kind === "request") {
      setToggles((current) => new Map(current).set(holder.block.requestId, true));
    }
    pendingJump.current = id;
    highlightNonce.current += 1;
    const nonce = highlightNonce.current;
    setHighlight({ id, nonce });
    setTimeout(
      () => setHighlight((current) => (current?.nonce === nonce ? null : current)),
      HIGHLIGHT_MS,
    );
  };
  useImperativeHandle(ref, () => ({
    jump,
    scrollToEnd: () => list.current?.scrollToEnd({ animated: true }),
  }));

  const loadOlder = async () => {
    if (chat === null || !chat.hasMore || loadingOlder) return;
    setLoadingOlder(true);
    const reply = await actions.olderThan(teamId, chat, scope);
    setLoadingOlder(false);
    if (!reply.ok) return Dialog.alert("Could not load earlier messages", reply.message);
    setPages((current) => [...current, reply.value]);
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

  const openThread = (threadId: string) => {
    const params = { environmentId: String(environmentId), threadId: ThreadId.make(threadId) };
    selectDetail({ name: "Thread", params });
  };

  const requestProject = (requestId: AssistantGroupMessage["requestId"]) =>
    chat === null ? null : assistantGroupRequestProject(chat, requestId);
  const requestRoot = (requestId: AssistantGroupMessage["requestId"]) => {
    const projectId = requestProject(requestId);
    return (
      projects.find(
        (project) => project.environmentId === environmentId && project.id === projectId,
      )?.workspaceRoot ?? null
    );
  };

  const pickProject = async (block: AssistantGroupRequestBlock, project: GroupComposerProject) => {
    const reply = await actions.post({
      teamId,
      text: project.name,
      replyToMessageId: block.requestId,
      projectId: project.id,
    });
    if (!reply.ok) Dialog.alert("Could not set the project", reply.message);
  };

  const toggle = (block: AssistantGroupRequestBlock, expanded: boolean) =>
    setToggles((current) => new Map(current).set(block.requestId, !expanded));

  return (
    <PresentationSource identifier={links.fileShareSourceIdentifier} style={{ flex: 1 }}>
      <View className="flex-1">
        <LegendList
          // The initial position is read at mount, so the list restarts once the chat has loaded.
          key={chat === null ? "loading" : "ready"}
          ref={list}
          renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
          className="flex-1"
          // Added to the bar's automatic inset, so the pinned tab row covers nothing.
          contentInset={topInset === undefined ? undefined : { top: topInset }}
          scrollIndicatorInsets={topInset === undefined ? undefined : { top: topInset }}
          data={feedEntries}
          // A reconnect brings a new image resolver to the rows.
          extraData={{ chat, highlight, imageSources: links.imageSources }}
          estimatedItemSize={72}
          keyExtractor={entryKey}
          alignItemsAtEnd
          initialScrollAtEnd={jumpTo === null}
          initialScrollIndex={jumpTo ?? undefined}
          maintainScrollAtEnd
          maintainVisibleContentPosition
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onStartReached={() => void loadOlder()}
          onScroll={({ nativeEvent }) => {
            setScrolled(true);
            setAtBottom(
              nativeEvent.contentSize.height -
                nativeEvent.contentOffset.y -
                nativeEvent.layoutMeasurement.height <
                48,
            );
          }}
          scrollEventThrottle={100}
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
          renderItem={({ item }) =>
            item.kind === "header" ? (
              isAll ? (
                <AllRequestLine
                  block={item.block}
                  chip={item.block.projectId === null ? null : projectName(item.block.projectId)}
                  expanded={item.expanded}
                  onToggle={() => toggle(item.block, item.expanded)}
                />
              ) : (
                <RequestHeader
                  block={item.block}
                  projectName={
                    item.block.projectId === null ? null : projectName(item.block.projectId)
                  }
                  expanded={item.expanded}
                  onToggle={() => toggle(item.block, item.expanded)}
                />
              )
            ) : item.kind === "footer" ? (
              <RequestFooter
                block={item.block}
                projects={groupProjects}
                disabled={archived || !actions.canPost}
                onPickProject={(project) => void pickProject(item.block, project)}
                onReply={() =>
                  props.onReply({
                    id: item.block.requestId,
                    name: item.block.title,
                    to: null,
                    projectId: item.block.projectId,
                    excerpt: groupMessageExcerpt(
                      chat?.messages.get(item.block.requestId)?.text ?? item.block.title,
                    ),
                  })
                }
              />
            ) : (
              <Fragment>
                {item.row.message.seq === newSeq ? <NewDivider /> : null}
                <View>
                  <FeedRow
                    environmentId={environmentId}
                    row={item.row}
                    chat={chat!}
                    assistants={byId}
                    members={members}
                    projects={groupProjects}
                    lead={lead}
                    canAct={actions.canAct}
                    archived={archived}
                    onReply={(message, name) =>
                      props.onReply({
                        id: message.id,
                        name,
                        to: name,
                        projectId: requestProject(message.requestId),
                        excerpt: groupMessageExcerpt(message.text),
                      })
                    }
                    onJump={jump}
                    onPreview={links.onPressPreview}
                    linkHost={linkHost}
                    workspaceRoot={requestRoot(item.row.message.requestId)}
                    onTaskAction={(task, action, ownerId) => void taskAction(task, action, ownerId)}
                    onOpenConversation={(task) => openThread(task.threadId)}
                    onOpenThread={openThread}
                  />
                  {highlight?.id === item.row.message.id ? (
                    <JumpHighlight key={highlight.nonce} />
                  ) : null}
                </View>
              </Fragment>
            )
          }
        />
        <VideoPreviewModal source={links.expandedVideo} onRequestClose={links.closeVideoPreview} />
        <FilePreviewModal source={links.expandedFile} onRequestClose={links.closeFilePreview} />
      </View>
    </PresentationSource>
  );
}

export function AssistantGroupChatRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly teamId: string;
  /** The tab a push opens, from its link. */
  readonly tab?: string;
}>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const teamId = AssistantTeamId.make(route.params.teamId);
  const goBack = useWorkspaceBackNavigation("threads");
  const entries = useAssistantEntries();
  const actions = useAssistantGroupActions(environmentId);
  const flows = useAssistantTeamFlows(environmentId);
  const openTeam = useOpenAssistantTeam();
  const openEditor = useOpenAssistantEditor();
  const projects = useProjects();
  const people = useGroupPeople(environmentId, teamId);
  const { team, everyone, members, groupProjects, projectName } = people;
  const savedTab = useGroupTabPreference(environmentId, teamId);
  const navigation = useNavigation();
  const pushedTab = route.params.tab;
  const keepPushedTab = useEffectEvent((pushed: string) => {
    savedTab.save(pushed);
    navigation.setParams({ tab: undefined } as never);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a push's tab becomes the saved one (an optimistic write), then leaves the route so later picks stand
  useEffect(() => {
    if (pushedTab !== undefined) keepPushedTab(pushedTab);
  }, [pushedTab]);
  // Until members and projects arrive, tabs may only be missing: no feed, so nothing reads unscoped.
  const { pending, tabs, tab, scope } = assistantGroupTabView({
    team,
    members,
    projects: projects.filter((project) => project.environmentId === environmentId),
    assistants: people.byId,
    saved: pushedTab ?? savedTab.saved,
    loading: pushedTab === undefined && savedTab.loading,
  });
  const mount = useId();
  const tabKey = pending ? null : (tab?.key ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- push presentation runs outside React and skips only the tab on screen
  useEffect(
    () =>
      showAgentNotificationGroupTab(
        mount,
        buildAssistantGroupDeepLink({ environmentId, teamId }),
        pending ? undefined : tabKey,
      ),
    [mount, environmentId, teamId, pending, tabKey],
  );
  const live = useAssistantGroupChat(environmentId, teamId, scope);
  const feed = useRef<GroupFeedHandle>(null);
  const [replyTo, setReplyTo] = useState<GroupReply | null>(null);
  // The composer's own project pick, until a send or another tab.
  const [projectPick, setProjectPick] = useState<AssistantGroupProjectPick | null>(null);
  // Bumped by Clear history, so the feed drops the pages it loaded before.
  const [clears, setClears] = useState(0);
  const [tabsHeight, setTabsHeight] = useState(0);
  // Another tab, chosen or not (the saved one loading, a removed one), drops both picks for good.
  if (assistantGroupTabPick(projectPick, tabKey) !== projectPick) setProjectPick(null);

  const composerProject = assistantGroupComposerProject({
    pick: projectPick,
    tab,
    replying: replyTo !== null,
    groupProjects,
  });
  // The project the next message runs in: a reply's request project, else the composer's.
  const modelProjectId = replyTo?.projectId ?? composerProject;
  const projectModel = useGroupProjectModel(
    environmentId,
    modelProjectId,
    team === undefined || modelProjectId === null
      ? null
      : (teamModelLayer(team, members, modelProjectId) ?? null),
    { teamId, tab: tabKey },
  );
  const [modelPick, setModelPick] = useAtom(groupMessageModelAtom(teamId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the pick's atom outlives the screen and cannot be set while rendering
  useEffect(() => {
    if (assistantGroupTabPick(modelPick, tabKey) !== modelPick) setModelPick(null);
  }, [modelPick, tabKey, setModelPick]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the pick's atom outlives the screen; leaving the group drops it
  useEffect(() => () => setModelPick(null), [setModelPick]);

  const selectTab = (next: AssistantGroupTab) => {
    if (next.key === tab?.key) return;
    savedTab.save(next.key);
    setReplyTo(null);
  };

  const send = async (
    text: string,
    attachments: ReadonlyArray<ChatAttachment>,
    projectId: ProjectId | undefined,
    requestId: string,
  ): Promise<GroupSendResult> => {
    const reply = await actions.post({
      teamId,
      text,
      clientRequestId: requestId,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(replyTo === null ? {} : { replyToMessageId: replyTo.id }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(projectModel?.messageModel === undefined
        ? {}
        : { modelSelection: projectModel.messageModel }),
    });
    if (reply.ok) {
      // What the user changed while the post was on its way stays: a new reply, pick or tab.
      setReplyTo((current) => (current === replyTo ? null : current));
      setProjectPick((current) => (current === projectPick ? null : current));
      setModelPick((current) => (current === modelPick ? null : current));
      feed.current?.scrollToEnd();
      // A request that lands in another project's tab would vanish from this one: follow it.
      const landed = replyTo?.projectId ?? projectId ?? null;
      if (tabs !== null && tab !== null) {
        savedTab.save((saved) => assistantGroupTabAfterSend(tabs, tab.key, saved, landed));
      }
      return { ok: true };
    }
    return {
      ok: false,
      message:
        // A refusal for want of a mention carries the server's why (the lead's model cannot route).
        reply.reason === "archived"
          ? "This group is archived. Restore it to write here."
          : reply.message,
    };
  };

  if (team === undefined) {
    return (
      <View className="flex-1 bg-screen">
        <AppBar title="Group chat" onBackToList={goBack} hideBottomBorder />
        {entries.environmentIds.includes(environmentId) ? (
          <EmptyState title="Group not found" detail="It may have been deleted." variant="plain" />
        ) : null}
      </View>
    );
  }

  const archived = team.archivedAt != null;
  // The whole group's count: a scoped tab's stream holds only that tab's tasks.
  const running = team.chat?.runningCount ?? (live === null ? 0 : assistantGroupRunningCount(live));
  // As in Group settings: the conversation does not change under running work.
  const converseDisabled = !flows.canConverse || team.chat?.working === true;
  // The server refuses these while tasks run; the menu says why instead of only greying them out.
  const converseHint = team.chat?.working === true ? { subtitle: "Stop its tasks first" } : {};
  const tabRow =
    tabs === null || tab === null ? null : (
      <GroupProjectTabs
        tabs={tabs}
        activeKey={tab.key}
        onSelect={selectTab}
        onHeight={setTabsHeight}
      />
    );
  return (
    <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
      <AppBar
        title={team.name}
        subtitle={[teamSummary(team, everyone), running > 0 ? `${running} running` : null]
          .filter((part) => part !== null)
          .join(" · ")}
        onBackToList={goBack}
        hideBottomBorder
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
                id: "settings",
                title: "Group settings",
                icon: "gearshape",
                onPress: () => openTeam.settings(environmentId, team.id),
              },
              {
                id: "new",
                title: "New assistant in this group",
                icon: "plus",
                onPress: () => openEditor(environmentId, null, { teamId: team.id }),
              },
              {
                id: "routines",
                title: "Group routines",
                icon: "calendar.badge.clock",
                onPress: () => openTeam.settings(environmentId, team.id, "routines"),
              },
              ...(projectModel === null || modelProjectId === null || members.length === 0
                ? []
                : [
                    {
                      id: "member-models",
                      title: `Model in ${projectName(modelProjectId)}`,
                      icon: "cube",
                      items: [
                        {
                          id: "model:project",
                          title: "Project's model",
                          subtitle: projectModel.defaultLabel,
                          icon: "folder.fill",
                          disabled: !projectModel.canWrite,
                          onPress: projectModel.openProjectPicker,
                        },
                        ...members.map((member) => {
                          const exception = projectModel.exceptions[member.id];
                          const disabled = !projectModel.canWrite;
                          return exception === undefined
                            ? {
                                id: `model:${member.id}`,
                                title: member.name,
                                subtitle: "No exception",
                                disabled,
                                onPress: () => projectModel.openMemberPicker(member.id),
                              }
                            : {
                                id: `model:${member.id}`,
                                title: `${member.name} · ${projectModel.nameOf(exception)}`,
                                items: [
                                  {
                                    id: `model:${member.id}:change`,
                                    title: "Change model",
                                    icon: "cube",
                                    disabled,
                                    onPress: () => projectModel.openMemberPicker(member.id),
                                  },
                                  {
                                    id: `model:${member.id}:remove`,
                                    title: "Remove exception",
                                    icon: "trash",
                                    destructive: true,
                                    disabled,
                                    onPress: () => projectModel.removeException(member.id),
                                  },
                                ],
                              };
                        }),
                      ],
                    },
                  ]),
              {
                id: "new-conversation",
                title: "New conversation",
                icon: "plus.bubble",
                disabled: converseDisabled,
                ...converseHint,
                onPress: () => void flows.converse(team, "new"),
              },
              {
                id: "compact",
                title: "Compact context",
                icon: "arrow.down.right.and.arrow.up.left",
                disabled: converseDisabled,
                ...converseHint,
                onPress: () => void flows.converse(team, "compact"),
              },
              {
                id: "clear",
                title: "Clear history",
                icon: "trash",
                destructive: true,
                disabled: converseDisabled,
                ...converseHint,
                onPress: () => {
                  // An alert over an open keyboard leaves a stale keyboard height behind.
                  Keyboard.dismiss();
                  flows.clear(team, () => {
                    // Pages loaded before the clear would come back under the new messages.
                    setClears((count) => count + 1);
                    setReplyTo(null);
                  });
                },
              },
              (team.chat?.unreadCount ?? 0) > 0
                ? {
                    id: "read",
                    title: "Mark as read",
                    icon: "envelope.open",
                    disabled: !flows.canMarkRead,
                    onPress: () => void flows.markRead(team),
                  }
                : {
                    id: "unread",
                    title: "Mark as unread",
                    icon: "envelope.badge",
                    disabled: !flows.canMarkRead,
                    onPress: () => void flows.markUnread(team),
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
      {Platform.OS === "ios" ? null : tabRow}
      {pending ? (
        <View className="flex-1" />
      ) : (
        <GroupFeed
          key={`${tab?.key ?? "chat"}:${clears}`}
          ref={feed}
          environmentId={environmentId}
          team={team}
          people={people}
          actions={actions}
          tab={tab}
          live={live}
          topInset={tabRow !== null && Platform.OS === "ios" ? tabsHeight : undefined}
          onReply={setReplyTo}
        />
      )}
      {Platform.OS === "ios" ? tabRow : null}
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
        teamId={team.id}
        tab={tabKey}
        members={members}
        leadId={team.leadId}
        projects={groupProjects}
        projectId={composerProject}
        onProjectChange={(projectId) => setProjectPick({ tab: tabKey, value: projectId })}
        projectName={projectName}
        projectModel={projectModel}
        disabled={archived || !actions.canPost}
        disabledReason={archived ? "Restore the group to write here" : null}
        replyingTo={replyTo}
        onJumpToReply={
          replyTo === null || live?.messages.get(replyTo.id) === undefined
            ? null
            : () => feed.current?.jump(replyTo.id)
        }
        onClearReply={() => setReplyTo(null)}
        onSend={send}
      />
    </KeyboardAvoidingView>
  );
}
