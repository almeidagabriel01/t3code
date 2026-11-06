import {
  assistantAccent,
  assistantInitial,
  assistantSenders,
} from "@t3tools/client-runtime/assistantPresence";
import { resolveSidebarThreadStatus } from "@t3tools/client-runtime/state/thread-attention";
import type { MenuAction } from "@react-native-menu/menu";
import type { Assistant, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useAssistantActions, useAssistantEntries } from "../../state/assistants";
import { useThreadShells } from "../../state/entities";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import * as Dialog from "../../components/ui/Dialog";
import {
  accentWash,
  presenceMessageCount,
  presenceBadgeLabel,
  presenceStatusLabel,
  splitPresenceStack,
} from "./assistantPresenceLabels";
import { AssistantIconGlyph, TOOL_ACCESS_OPTIONS, toolAccessLabel } from "./assistantPresentation";
import { assistantIconFor } from "@t3tools/client-runtime/assistantIcons";

type Who = {
  readonly name: string;
  readonly accent: string;
  readonly icon?: string | null | undefined;
};

function PresenceAvatar(props: {
  readonly who: Who;
  readonly size: number;
  readonly ring?: boolean;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center rounded-full"
      style={{
        width: props.size,
        height: props.size,
        backgroundColor: props.who.accent,
      }}
    >
      {assistantIconFor(props.who.icon) ? (
        <AssistantIconGlyph icon={props.who.icon} size={props.size * 0.62} color="#ffffff" />
      ) : (
        <Text className="font-t3-bold" style={{ fontSize: props.size * 0.5, color: "#ffffff" }}>
          {assistantInitial(props.who.name)}
        </Text>
      )}
    </View>
  );
}

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
          <PresenceAvatar who={{ name, accent, icon: assistant?.icon }} size={16} />
          <Text className="text-xs text-foreground-muted">
            {name} joined the conversation · {props.joinedAtLabel}
          </Text>
          <View className="h-px flex-1 bg-border" />
        </View>
      ) : null}
      <View className="flex-row items-start gap-2.5">
        <PresenceAvatar who={{ name, accent, icon: assistant?.icon }} size={28} />
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

/** Overlapping avatars of the assistants that wrote in this thread; one menu lists them. */
export function ThreadAssistantStack(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messages: Parameters<typeof assistantSenders>[0];
}) {
  const { messages } = props;
  const { active, archived } = useAssistantEntries();
  const actions = useAssistantActions(props.environmentId);
  const known = [...active, ...archived]
    .filter((entry) => entry.environmentId === props.environmentId)
    .map((entry) => entry.assistant);
  const senders = props.threadId.startsWith("assistant:") ? [] : assistantSenders(messages, known);
  if (senders.length === 0) return null;
  return (
    <PresenceStackView
      environmentId={props.environmentId}
      threadId={props.threadId}
      senders={senders}
      canAct={actions.canAct}
      onAccess={async (assistantId, toolAccess) => {
        const reply = await actions.update({
          assistantId: assistantId as Assistant["id"],
          toolAccess,
        });
        if (!reply.ok) Dialog.alert("Could not change access", reply.message);
      }}
    />
  );
}

function StackAvatar(props: {
  readonly sender: ReturnType<typeof assistantSenders>[number];
  readonly working: boolean;
  readonly overlap: boolean;
}) {
  const { sender } = props;
  return (
    <View
      className="rounded-full border-2 border-screen"
      style={{ marginLeft: props.overlap ? -7 : 0 }}
    >
      <PresenceAvatar
        who={{
          name: sender.assistant?.name ?? "Assistant",
          icon: sender.assistant?.icon,
          accent: assistantAccent(sender.assistantId),
        }}
        size={22}
      />
      <View
        className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-screen ${props.working ? "bg-success-foreground" : "bg-foreground-muted"}`}
      />
    </View>
  );
}

function menuActions(
  senders: ReadonlyArray<ReturnType<typeof assistantSenders>[number]>,
  workingById: ReadonlyMap<string, boolean>,
  canAct: boolean,
): MenuAction[] {
  return senders.map((sender) => ({
    id: `assistant:${sender.assistantId}`,
    title: sender.assistant?.name ?? "Assistant",
    subtitle: `${presenceStatusLabel(workingById.get(sender.assistantId) === true)} · ${presenceMessageCount(sender)}`,
    subactions: [
      {
        id: `${JUMP_PREFIX}${sender.assistantId}`,
        title: "Jump to last message",
        image: "arrow.down.to.line",
      },
      ...(sender.assistant
        ? [
            {
              id: `access-group:${sender.assistantId}`,
              title: "Access",
              displayInline: true,
              subactions: TOOL_ACCESS_OPTIONS.map((option) => ({
                id: `${ACCESS_PREFIX}${sender.assistantId}|${option.value}`,
                title: option.label,
                state:
                  sender.assistant?.toolAccess === option.value
                    ? ("on" as const)
                    : ("off" as const),
                attributes: { disabled: !canAct },
              })),
            },
          ]
        : []),
    ],
  }));
}

function PresenceStackView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly senders: ReadonlyArray<ReturnType<typeof assistantSenders>[number]>;
  readonly canAct: boolean;
  readonly onAccess: (assistantId: string, access: Assistant["toolAccess"]) => void;
}) {
  const { shown, hidden } = splitPresenceStack(props.senders);
  const shells = useThreadShells();
  const workingById = new Map(
    props.senders.map((sender) => {
      const threadId = sender.assistant?.threadId;
      const shell = threadId
        ? shells.find((s) => s.environmentId === props.environmentId && s.id === threadId)
        : undefined;
      return [
        sender.assistantId,
        shell !== undefined && resolveSidebarThreadStatus(shell) === "working",
      ];
    }),
  );
  return (
    <Menu
      actions={menuActions(props.senders, workingById, props.canAct)}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (id.startsWith(JUMP_PREFIX)) {
          const sender = props.senders.find(
            (candidate) => candidate.assistantId === id.slice(JUMP_PREFIX.length),
          );
          if (sender)
            requestThreadMessageJump(
              scopedThreadKey(props.environmentId, props.threadId),
              sender.lastMessageId as MessageId,
            );
        } else if (id.startsWith(ACCESS_PREFIX)) {
          const [assistantId, access] = id.slice(ACCESS_PREFIX.length).split("|");
          props.onAccess(assistantId!, access as Assistant["toolAccess"]);
        }
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Assistants in this conversation: ${props.senders
          .map((sender) => sender.assistant?.name ?? "Assistant")
          .join(", ")}`}
        hitSlop={6}
        className="flex-row items-center self-end rounded-full border border-border py-0.5 pl-0.5 pr-1.5 active:opacity-70"
      >
        {shown.map((sender, index) => (
          <StackAvatar
            key={sender.assistantId}
            sender={sender}
            working={workingById.get(sender.assistantId) === true}
            overlap={index > 0}
          />
        ))}
        {hidden > 0 ? (
          <Text className="ml-1.5 text-2xs text-foreground-muted">+{hidden}</Text>
        ) : null}
      </Pressable>
    </Menu>
  );
}
