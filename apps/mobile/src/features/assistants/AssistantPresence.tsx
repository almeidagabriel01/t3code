import {
  ASSISTANT_PRESENCE_SECTIONS,
  assistantAccent,
  assistantPresenceSections,
  assistantPresenceStatus,
  assistantSenderLook,
  assistantSenders,
  assistantThreadSenders,
  type AssistantPresenceSection,
} from "@t3tools/client-runtime/assistantPresence";
import {
  assistantTaskState,
  canDismissAssistantTask,
  type AssistantTaskState,
} from "@t3tools/client-runtime/assistantTasks";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MenuAction } from "@react-native-menu/menu";
import type { Assistant, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import {
  useAssistantActions,
  useAssistantEntries,
  useAssistantStatus,
  useAssistantTask,
  useTaskAssistant,
} from "../../state/assistants";
import { useThreadShell } from "../../state/entities";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import * as Dialog from "../../components/ui/Dialog";
import { accentWash, presenceBadgeLabel } from "./assistantPresenceLabels";
import {
  AssistantAvatar,
  AssistantCluster,
  removedAssistantFace,
  TOOL_ACCESS_OPTIONS,
  toolAccessLabel,
} from "./assistantPresentation";
import { useAssistantFlows } from "./useAssistantFlows";
import { useOpenAssistantInfo } from "./openAssistantInfo";

/** Who wrote in this agent's conversation: the assistant's own avatar, name, and access, in its color. */
export function AssistantFeedMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly assistantId: string;
  /** Set on the assistant's first message in the thread. */
  readonly joinedAtLabel: string | null;
  readonly children: ReactNode;
}) {
  const { active, archived } = useAssistantEntries();
  const assistant =
    [...active, ...archived].find(
      (entry) =>
        entry.environmentId === props.environmentId && entry.assistant.id === props.assistantId,
    )?.assistant ?? null;
  const name = assistant?.name ?? "Assistant";
  const accent = assistantAccent(props.assistantId);
  const face = assistant ?? removedAssistantFace(props.assistantId);
  const access = assistant ? toolAccessLabel(assistant.toolAccess) : null;
  return (
    <View className="mb-4 gap-3 px-1">
      {props.joinedAtLabel !== null ? (
        <View
          accessible
          accessibilityLabel={`${name} joined the conversation, ${props.joinedAtLabel}`}
          className="flex-row items-center gap-2"
        >
          <View className="h-px flex-1 bg-border" />
          <AssistantAvatar assistant={face} environmentId={props.environmentId} size={16} />
          <Text className="text-xs text-foreground-muted">
            {name} joined the conversation · {props.joinedAtLabel}
          </Text>
          <View className="h-px flex-1 bg-border" />
        </View>
      ) : null}
      <View className="flex-row items-start gap-2.5">
        <AssistantAvatar assistant={face} environmentId={props.environmentId} size={28} />
        <View className="min-w-0 shrink gap-1">
          <View className="flex-row items-center gap-1.5">
            <Text className="font-t3-bold text-xs text-foreground" numberOfLines={1}>
              {name}
            </Text>
            <View className="rounded-md border border-border px-1.5 py-px">
              <Text className="text-2xs text-foreground-muted">
                {presenceBadgeLabel(access, assistant?.askBeforeActing === true)}
              </Text>
            </View>
          </View>
          <View
            className="min-w-0 self-start rounded-b-[14px] rounded-tr-[14px] rounded-tl px-3 py-2"
            style={{
              backgroundColor: accentWash(accent, 0.12),
              borderWidth: 1,
              borderColor: accentWash(accent, 0.35),
            }}
          >
            {props.children}
          </View>
        </View>
      </View>
    </View>
  );
}

const ACCESS_PREFIX = "access:";
const JUMP_PREFIX = "jump:";
const CHAT_PREFIX = "chat:";
const INFO_PREFIX = "info:";
const DISMISS_TASK = "task:dismiss";
const RESTORE_TASK = "task:restore";
const SECTION_IMAGE = {
  needs: "exclamationmark.circle",
  working: "hammer",
  idle: "moon",
} as const satisfies Record<AssistantPresenceSection, string>;

type Sender = ReturnType<typeof assistantSenders>[number];
type SenderLook = ReturnType<typeof assistantSenderLook>;
/** The task this thread is, when an assistant launched it; its owner's row carries the task's actions. */
export interface PresenceTask {
  readonly assistantId: string;
  readonly state: AssistantTaskState;
  readonly dismissed: boolean;
}

/**
 * The thread's one assistant control: who wrote here and the assistant that launched it as a task,
 * as one cluster; its menu lists Needs you, Working, then Idle, from each one's shared status.
 */
export function ThreadAssistantStack(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messages: Parameters<typeof assistantSenders>[0];
}) {
  const { messages } = props;
  const { active, archived } = useAssistantEntries();
  const actions = useAssistantActions(props.environmentId);
  const flows = useAssistantFlows(props.environmentId);
  const openInfo = useOpenAssistantInfo();
  const status = useAssistantStatus();
  const owner = useTaskAssistant(props.environmentId, props.threadId);
  const taskShell = useThreadShell(
    owner === null ? null : scopeThreadRef(props.environmentId, props.threadId),
  );
  const taskRecord = useAssistantTask(props.environmentId, props.threadId);
  const known = [...active, ...archived]
    .filter((entry) => entry.environmentId === props.environmentId)
    .map((entry) => entry.assistant);
  const senders = props.threadId.startsWith("assistant:")
    ? []
    : assistantThreadSenders(assistantSenders(messages, known), owner?.assistant ?? null);
  if (senders.length === 0) return null;
  const task: PresenceTask | null =
    owner === null
      ? null
      : {
          assistantId: owner.assistant.id,
          state: taskShell === null ? "running" : assistantTaskState(taskShell),
          dismissed: taskRecord?.dismissedAt != null,
        };
  const looks = new Map(
    senders.map((sender) => [
      sender.assistantId,
      assistantSenderLook(sender, status.of(props.environmentId, sender.assistant)),
    ]),
  );
  return (
    <PresenceStackView
      environmentId={props.environmentId}
      threadId={props.threadId}
      senders={senders}
      looks={looks}
      task={task}
      canAct={actions.canAct}
      onDismissTask={() => void flows.dismissTask(props.threadId)}
      onRestoreTask={() => void flows.restoreTask(props.threadId)}
      onAccess={async (assistantId, toolAccess) => {
        const reply = await actions.update({
          assistantId: assistantId as Assistant["id"],
          toolAccess,
        });
        if (!reply.ok) Dialog.alert("Could not change access", reply.message);
      }}
      onOpenChat={(assistant) => flows.openConversation(assistant)}
      onOpenInfo={(assistantId) =>
        openInfo.assistant(props.environmentId, assistantId as Assistant["id"])
      }
    />
  );
}

function taskAction(task: PresenceTask, canAct: boolean): MenuAction {
  return task.dismissed
    ? {
        id: RESTORE_TASK,
        title: "Restore task",
        image: "arrow.uturn.backward",
        attributes: { disabled: !canAct },
      }
    : {
        id: DISMISS_TASK,
        title: "Dismiss task",
        image: "xmark",
        attributes: { disabled: !canAct || !canDismissAssistantTask(task.state) },
      };
}

function senderActions(
  sender: Sender,
  section: AssistantPresenceSection,
  canAct: boolean,
  task: PresenceTask | null,
): MenuAction {
  const { assistant } = sender;
  return {
    id: `assistant:${sender.assistantId}`,
    title: assistant?.name ?? "Assistant",
    image: SECTION_IMAGE[section],
    // A native menu subtitle wraps past one line; the message badge already says "asks first".
    subtitle: assistantPresenceStatus(section, sender, false),
    subactions: [
      ...(sender.count === 0
        ? []
        : [
            {
              id: `${JUMP_PREFIX}${sender.assistantId}`,
              title: "Jump to last message",
              image: "arrow.down.to.line",
            },
          ]),
      ...(assistant
        ? [
            {
              id: `access-group:${sender.assistantId}`,
              title: "Access",
              image: "lock",
              displayInline: true,
              subactions: TOOL_ACCESS_OPTIONS.map((option) => ({
                id: `${ACCESS_PREFIX}${sender.assistantId}|${option.value}`,
                title: option.label,
                state: assistant.toolAccess === option.value ? ("on" as const) : ("off" as const),
                attributes: { disabled: !canAct },
              })),
            },
            {
              id: `${CHAT_PREFIX}${sender.assistantId}`,
              title: "Open chat",
              image: "bubble.left.and.bubble.right",
              attributes: { disabled: assistant.threadId === null },
            },
            {
              id: `${INFO_PREFIX}${sender.assistantId}`,
              title: "Assistant info",
              image: "info.circle",
            },
          ]
        : []),
      ...(task !== null && task.assistantId === sender.assistantId
        ? [taskAction(task, canAct)]
        : []),
    ],
  };
}

/**
 * The menu tree: a titled inline section for Needs you, Working, then Idle, omitting an empty one.
 * Android's popup draws inline sections as submenus, so there the rows stay flat in the same order;
 * each subtitle already starts with its section.
 */
export function presenceMenuActions(
  senders: ReadonlyArray<Sender>,
  looks: ReadonlyMap<string, SenderLook>,
  canAct: boolean,
  task: PresenceTask | null,
  inlineSections = Platform.OS !== "android",
): MenuAction[] {
  const sectionOf = (sender: Sender) => looks.get(sender.assistantId)?.section ?? "idle";
  const sections = assistantPresenceSections(senders, sectionOf);
  const rows = (id: AssistantPresenceSection) =>
    sections[id].map((sender) => senderActions(sender, id, canAct, task));
  if (!inlineSections) return ASSISTANT_PRESENCE_SECTIONS.flatMap(([id]) => rows(id));
  return ASSISTANT_PRESENCE_SECTIONS.filter(([id]) => sections[id].length > 0).map(
    ([id, title]) => ({
      id: `section:${id}`,
      title,
      image: SECTION_IMAGE[id],
      displayInline: true,
      subactions: rows(id),
    }),
  );
}

function PresenceStackView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly senders: ReadonlyArray<Sender>;
  readonly looks: ReadonlyMap<string, SenderLook>;
  readonly task: PresenceTask | null;
  readonly canAct: boolean;
  readonly onDismissTask: () => void;
  readonly onRestoreTask: () => void;
  readonly onAccess: (assistantId: string, access: Assistant["toolAccess"]) => void;
  readonly onOpenChat: (assistant: Assistant) => void;
  readonly onOpenInfo: (assistantId: string) => void;
}) {
  const byId = (id: string) => props.senders.find((candidate) => candidate.assistantId === id);
  return (
    // The menu anchors to its own frame and ignores layout classes, so this view sizes and places it.
    <View className="mb-1 mr-1.5 self-end">
      <Menu
        title={`Assistants in this thread · ${props.senders.length}`}
        actions={presenceMenuActions(props.senders, props.looks, props.canAct, props.task)}
        onPressAction={({ nativeEvent }) => {
          const id = nativeEvent.event;
          if (id === DISMISS_TASK) props.onDismissTask();
          else if (id === RESTORE_TASK) props.onRestoreTask();
          else if (id.startsWith(JUMP_PREFIX)) {
            const sender = byId(id.slice(JUMP_PREFIX.length));
            if (sender)
              requestThreadMessageJump(
                scopedThreadKey(props.environmentId, props.threadId),
                sender.lastMessageId as MessageId,
              );
          } else if (id.startsWith(ACCESS_PREFIX)) {
            const [assistantId, access] = id.slice(ACCESS_PREFIX.length).split("|");
            props.onAccess(assistantId!, access as Assistant["toolAccess"]);
          } else if (id.startsWith(CHAT_PREFIX)) {
            const assistant = byId(id.slice(CHAT_PREFIX.length))?.assistant;
            if (assistant) props.onOpenChat(assistant);
          } else if (id.startsWith(INFO_PREFIX)) {
            props.onOpenInfo(id.slice(INFO_PREFIX.length));
          }
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Assistants in this thread: ${props.senders
            .map((sender) => sender.assistant?.name ?? "Assistant")
            .join(", ")}`}
          hitSlop={6}
          className="rounded-lg p-1.5 active:opacity-70"
        >
          <AssistantCluster
            environmentId={props.environmentId}
            size={26}
            faces={props.senders.map((sender) => ({
              key: sender.assistantId,
              assistant: sender.assistant ?? removedAssistantFace(sender.assistantId),
              mood: props.looks.get(sender.assistantId)?.face ?? "sleeping",
            }))}
          />
        </Pressable>
      </Menu>
    </View>
  );
}
