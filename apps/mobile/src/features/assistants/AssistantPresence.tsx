import {
  assistantAccent,
  assistantPresenceSections,
  assistantPresenceStatus,
  assistantSenders,
} from "@t3tools/client-runtime/assistantPresence";
import {
  assistantFace,
  assistantPresenceOf,
  type AssistantPresence,
} from "@t3tools/client-runtime/assistantRobot";
import type { MenuAction } from "@react-native-menu/menu";
import type { Assistant, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useAssistantActions, useAssistantEntries } from "../../state/assistants";
import { useThreadShells } from "../../state/entities";
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

type Sender = ReturnType<typeof assistantSenders>[number];

/** The assistants that wrote in this thread, as one cluster; its menu lists Working, then Idle. */
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
  const shells = useThreadShells();
  const known = [...active, ...archived]
    .filter((entry) => entry.environmentId === props.environmentId)
    .map((entry) => entry.assistant);
  const senders = props.threadId.startsWith("assistant:") ? [] : assistantSenders(messages, known);
  if (senders.length === 0) return null;
  const presenceById = new Map(
    senders.map((sender) => [
      sender.assistantId,
      assistantPresenceOf(sender.assistant, props.environmentId, shells),
    ]),
  );
  return (
    <PresenceStackView
      environmentId={props.environmentId}
      threadId={props.threadId}
      senders={senders}
      presenceById={presenceById}
      canAct={actions.canAct}
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

function senderActions(sender: Sender, working: boolean, canAct: boolean): MenuAction {
  const { assistant } = sender;
  return {
    id: `assistant:${sender.assistantId}`,
    title: assistant?.name ?? "Assistant",
    subtitle: assistantPresenceStatus(working, sender, assistant?.askBeforeActing === true),
    subactions: [
      {
        id: `${JUMP_PREFIX}${sender.assistantId}`,
        title: "Jump to last message",
        image: "arrow.down.to.line",
      },
      ...(assistant
        ? [
            {
              id: `access-group:${sender.assistantId}`,
              title: "Access",
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
    ],
  };
}

/**
 * The menu tree: a titled inline section for Working, then Idle, omitting an empty one. Android's
 * popup draws inline sections as submenus, so there the rows stay flat in the same order; each
 * subtitle already starts with Working or Idle.
 */
export function presenceMenuActions(
  senders: ReadonlyArray<Sender>,
  presenceById: ReadonlyMap<string, AssistantPresence>,
  canAct: boolean,
  inlineSections = Platform.OS !== "android",
): MenuAction[] {
  const isWorking = (sender: Sender) => presenceById.get(sender.assistantId)?.mood === "working";
  const sections = assistantPresenceSections(senders, isWorking);
  if (!inlineSections) {
    return [...sections.working, ...sections.idle].map((sender) =>
      senderActions(sender, isWorking(sender), canAct),
    );
  }
  return (
    [
      ["working", "Working", sections.working],
      ["idle", "Idle", sections.idle],
    ] as const
  )
    .filter(([, , rows]) => rows.length > 0)
    .map(([id, title, rows]) => ({
      id: `section:${id}`,
      title,
      displayInline: true,
      subactions: rows.map((sender) => senderActions(sender, isWorking(sender), canAct)),
    }));
}

function PresenceStackView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly senders: ReadonlyArray<Sender>;
  readonly presenceById: ReadonlyMap<string, AssistantPresence>;
  readonly canAct: boolean;
  readonly onAccess: (assistantId: string, access: Assistant["toolAccess"]) => void;
  readonly onOpenChat: (assistant: Assistant) => void;
  readonly onOpenInfo: (assistantId: string) => void;
}) {
  const byId = (id: string) => props.senders.find((candidate) => candidate.assistantId === id);
  return (
    <Menu
      title={`Assistants in this thread · ${props.senders.length}`}
      actions={presenceMenuActions(props.senders, props.presenceById, props.canAct)}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (id.startsWith(JUMP_PREFIX)) {
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
        className="self-end rounded-lg p-0.5 active:opacity-70"
      >
        <AssistantCluster
          environmentId={props.environmentId}
          size={26}
          faces={props.senders.map((sender) => {
            const presence = props.presenceById.get(sender.assistantId);
            return {
              key: sender.assistantId,
              assistant: sender.assistant ?? removedAssistantFace(sender.assistantId),
              mood: sender.assistant && presence ? assistantFace(presence) : "sleeping",
            };
          })}
        />
      </Pressable>
    </Menu>
  );
}
