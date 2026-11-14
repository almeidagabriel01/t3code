import {
  ASSISTANT_GROUP_ALL_PROJECTS_LABEL,
  ASSISTANT_GROUP_REQUEST_STATUS_LABEL,
  applyAssistantGroupHistory,
  assistantGroupAuthorName,
  assistantGroupAwaitingRoute,
  assistantGroupFeedProjects,
  assistantGroupMarkdownMentions,
  assistantGroupRequestExpanded,
  assistantGroupRequestFeed,
  assistantGroupBoundaryLabel,
  assistantGroupLatestSeq,
  assistantGroupNewSeq,
  assistantGroupRunningCount,
  filterAssistantGroupFeed,
  type AssistantGroupChatState,
  type AssistantGroupFeedRow,
  type AssistantGroupRequestBlock,
  type AssistantGroupRequestStatus,
  assistantGroupMessageExcerpt,
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
  type ChatAttachment,
  type ProjectId,
  assistantGroupProjectIds,
  splitAssistantTransferText,
} from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Fragment, useEffect, useRef, useState } from "react";
import { Keyboard, Linking, Platform, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { useReducedMotion, withTiming } from "react-native-reanimated";

import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
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
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import {
  useAssistantEntries,
  useAssistantGroupActions,
  useAssistantGroupChat,
} from "../../state/assistants";
import { useDecisionEntries } from "../../state/decisions";
import { useProjects } from "../../state/entities";
import { DecisionCard } from "../decisions/DecisionCard";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useMarkdownStyles } from "../threads/ThreadFeed";
import { GroupMessageAttachments } from "./GroupAttachments";
import {
  MENTION_REQUIRED_COPY,
  GroupComposer,
  type GroupComposerProject,
  type GroupReplyTarget,
  type GroupSendResult,
} from "./GroupComposer";
import { GroupStatusLabel, GroupTaskCard, type GroupStatusTone } from "./GroupTaskCard";
import { AssistantAvatar } from "./assistantPresentation";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useAssistantTeamFlows } from "./useAssistantFlows";
import { useGroupReadMarker } from "./useGroupReadMarker";

/** A mention link is a highlight only; any other link opens as the native view would. */
const onMarkdownLink = (href: string) => {
  if (!href.startsWith("t3-mention:")) void Linking.openURL(href);
};

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

function GroupMarkdown(props: {
  readonly text: string;
  readonly members: ReadonlyArray<Assistant>;
  readonly projects: ReadonlyArray<GroupComposerProject>;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  const mentions = composerGroupMentions(
    props.members,
    props.projects,
    useAssistantFaceImages(props.members),
  );
  return (
    <SelectableMarkdownText
      markdown={assistantGroupMarkdownMentions(props.text, props.members, props.projects)}
      onLinkPress={onMarkdownLink}
      linkCustomization={(href) => mentionChip(href, mentions)}
      textStyle={props.textStyle}
      preserveSoftBreaks
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

function TaskCards(
  props: TaskHandlers & {
    readonly environmentId: EnvironmentId;
    readonly tasks: ReadonlyArray<AssistantGroupTask>;
    readonly showOwner: boolean;
  },
) {
  return props.tasks.map((task) => (
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
  ));
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
  },
) {
  const { message } = props.row;
  const styles = useMarkdownStyles();
  const author =
    message.assistantId === null ? undefined : props.assistants.get(message.assistantId);
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
            text={parts.body}
            members={props.members}
            projects={props.projects}
            textStyle={(fromUser ? styles.user : styles.assistant).nativeTextStyle}
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
              text={message.text}
              members={props.members}
              projects={props.projects}
              textStyle={styles.assistant.nativeTextStyle}
            />
          </Pressable>
        </Menu>
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
  const [pages, setPages] = useState<ReadonlyArray<AssistantGroupsHistoryResult>>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const projects = useProjects();
  const [replyTo, setReplyTo] = useState<
    (GroupReplyTarget & { readonly id: AssistantGroupMessage["id"] }) | null
  >(null);
  // A message to bring into view once the list holds it (its request may still be folded).
  const pendingJump = useRef<AssistantGroupMessage["id"] | null>(null);
  const [highlight, setHighlight] = useState<{
    readonly id: AssistantGroupMessage["id"];
    readonly nonce: number;
  } | null>(null);
  const highlightNonce = useRef(0);
  const [filterPick, setFilterPick] = useState<ProjectId | null>(null);
  // The user's own fold or open of a request, over the default.
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const list = useRef<LegendListRef>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  // Where the "New" line goes, fixed when the chat first shows: it stays until the user leaves.
  const [newSeq, setNewSeq] = useState<number | null | undefined>(undefined);
  // The read position at open, so requests do not fold away as the chat is marked read.
  const [openReadSeq, setOpenReadSeq] = useState(0);

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
  const archived = team?.archivedAt != null;
  const lead = members.find((member) => member.id === team?.leadId);
  if (newSeq === undefined && chat !== null && team !== undefined) {
    // A server without counters sends none: there is no position to draw a line from.
    setNewSeq(team.chat === undefined ? null : assistantGroupNewSeq(chat, team.chat.readSeq));
    setOpenReadSeq(team.chat?.readSeq ?? 0);
  }

  const projectName = (id: ProjectId) =>
    projects.find((project) => project.environmentId === environmentId && project.id === id)
      ?.title ?? "Project";
  const groupProjects: ReadonlyArray<GroupComposerProject> = assistantGroupProjectIds(
    members,
    team?.projectIds ?? [],
  ).map((id) => ({ id, name: projectName(id) }));
  const items = chat === null ? [] : assistantGroupRequestFeed(chat);
  const feedProjects = assistantGroupFeedProjects(items);
  const filter = filterPick !== null && feedProjects.includes(filterPick) ? filterPick : null;
  const visible = filterAssistantGroupFeed(items, filter);
  const newestRequest = visible.findLast((item) => item.kind === "request");
  const feedEntries: FeedEntry[] = visible.flatMap((item): FeedEntry[] => {
    if (item.kind === "row") return [item];
    const { block } = item;
    const expanded =
      toggles.get(block.requestId) ??
      assistantGroupRequestExpanded(block, openReadSeq, item === newestRequest);
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
    readSeq: team?.chat?.readSeq ?? 0,
    // The list opens at the New line when it jumps, so nothing is at the end until the user scrolls.
    atBottom: scrolled ? atBottom : jumpTo === null,
    enabled: team?.chat !== undefined && actions.canMarkRead,
    markRead: (readSeq) => void actions.markRead(teamId, { readSeq }),
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
    const holder = items.find(
      (item) =>
        item.kind === "request" &&
        (item.block.requestId === id || item.block.rows.some((row) => row.message.id === id)),
    );
    if (holder?.kind === "request") {
      setToggles((current) => new Map(current).set(holder.block.requestId, true));
      if (!visible.includes(holder)) setFilterPick(null);
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

  const loadOlder = async () => {
    if (chat === null || !chat.hasMore || loadingOlder) return;
    setLoadingOlder(true);
    const reply = await actions.olderThan(teamId, chat);
    setLoadingOlder(false);
    if (!reply.ok) return Dialog.alert("Could not load earlier messages", reply.message);
    setPages((current) => [...current, reply.value]);
  };

  const send = async (
    text: string,
    attachments: ReadonlyArray<ChatAttachment>,
    projectId: ProjectId | undefined,
  ): Promise<GroupSendResult> => {
    const reply = await actions.post({
      teamId,
      text,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(replyTo === null ? {} : { replyToMessageId: replyTo.id }),
      ...(projectId === undefined ? {} : { projectId }),
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

  const openThread = (threadId: string) => {
    const params = { environmentId: String(environmentId), threadId: ThreadId.make(threadId) };
    selectDetail({ name: "Thread", params });
  };

  const requestProject = (requestId: AssistantGroupMessage["requestId"]) => {
    if (requestId === undefined || chat === null) return null;
    return (chat.messages.get(requestId) ?? chat.requests.get(requestId))?.projectId ?? null;
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

  if (team === undefined) {
    return (
      <View className="flex-1 bg-screen">
        <AppBar title="Group chat" onBack={() => navigation.goBack()} />
        {entries.environmentIds.includes(environmentId) ? (
          <EmptyState title="Group not found" detail="It may have been deleted." variant="plain" />
        ) : null}
      </View>
    );
  }

  const running = chat === null ? 0 : assistantGroupRunningCount(chat);
  // As in Group settings: the conversation does not change under running work.
  const converseDisabled = !flows.canConverse || team.chat?.working === true;
  return (
    <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
      <AppBar
        title={team.name}
        subtitle={[
          teamSummary(team, everyone),
          running > 0 ? `${running} running` : null,
          filter === null ? null : projectName(filter),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        onBack={() => navigation.goBack()}

        menus={[
          {
            title: `${team.name} actions`,
            icon: "ellipsis",
            items: [
              ...(feedProjects.length < 2
                ? []
                : [
                    {
                      id: "filter",
                      title: "Show",
                      inline: true,
                      items: [null, ...feedProjects].map((id) => ({
                        id: id ?? "all",
                        title: id === null ? ASSISTANT_GROUP_ALL_PROJECTS_LABEL : projectName(id),
                        selected: id === filter,
                        onPress: () => setFilterPick(id),
                      })),
                    },
                  ]),
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
              {
                id: "new-conversation",
                title: "New conversation",
                icon: "plus.bubble",
                disabled: converseDisabled,
                onPress: () => void flows.converse(team, "new"),
              },
              {
                id: "compact",
                title: "Compact context",
                icon: "arrow.down.right.and.arrow.up.left",
                disabled: converseDisabled,
                onPress: () => void flows.converse(team, "compact"),
              },
              {
                id: "clear",
                title: "Clear history",
                icon: "trash",
                destructive: true,
                disabled: converseDisabled,
                onPress: () => {
                  // An alert over an open keyboard leaves a stale keyboard height behind.
                  Keyboard.dismiss();
                  flows.clear(team, () => {
                    // Pages loaded before the clear would come back under the new messages.
                    setPages([]);
                    setToggles(new Map());
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
      <LegendList
        // The initial position is read at mount, so the list restarts once the chat has loaded.
        key={chat === null ? "loading" : "ready"}
        ref={list}
        renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
        className="flex-1"
        data={feedEntries}
        extraData={{ chat, highlight }}
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
            <RequestHeader
              block={item.block}
              projectName={item.block.projectId === null ? null : projectName(item.block.projectId)}
              expanded={item.expanded}
              onToggle={() => toggle(item.block, item.expanded)}
            />
          ) : item.kind === "footer" ? (
            <RequestFooter
              block={item.block}
              projects={groupProjects}
              disabled={archived || !actions.canPost}
              onPickProject={(project) => void pickProject(item.block, project)}
              onReply={() =>
                setReplyTo({
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
                    setReplyTo({
                      id: message.id,
                      name,
                      to: name,
                      projectId: requestProject(message.requestId),
                      excerpt: groupMessageExcerpt(message.text),
                    })
                  }
                  onJump={jump}
                  onPreview={setPreview}
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
        members={members}
        leadId={team.leadId}
        projects={groupProjects}
        defaultProjectId={groupProjects.some((project) => project.id === filter) ? filter : null}
        disabled={archived || !actions.canPost}
        disabledReason={archived ? "Restore the group to write here" : null}
        replyingTo={replyTo}
        onJumpToReply={
          replyTo === null || chat?.messages.get(replyTo.id) === undefined
            ? null
            : () => jump(replyTo.id)
        }
        onClearReply={() => setReplyTo(null)}
        onSend={send}
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </KeyboardAvoidingView>
  );
}
