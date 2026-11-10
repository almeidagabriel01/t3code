import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Platform, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useSideChats } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { useStartSideChat } from "./useStartSideChat";

/**
 * The thread's side chats, and a way to start one. Each opens as a normal thread, so its
 * approvals and questions can be answered from the phone.
 */
export function ThreadSideChatsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly canOperate: boolean;
}) {
  const sideChats = useSideChats({ environmentId: props.environmentId, threadId: props.threadId });
  const openLinkedThread = useOpenLinkedThread();
  const startSideChat = useStartSideChat(props.environmentId);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const turnIntoThread = async (threadId: ThreadId) => {
    const result = await updateMetadata({
      environmentId: props.environmentId,
      input: { threadId, detachSideChat: true, regenerateTitle: true },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not turn into thread",
        cause instanceof Error ? cause.message : "Try again.",
      );
      return;
    }
    openLinkedThread({ environmentId: props.environmentId, threadId });
  };
  if (sideChats.length === 0 && !props.canOperate) return null;
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 py-2 pl-4",
        Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
      )}
    >
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <Text className="text-xs text-foreground-muted">Side chats</Text>
      {props.canOperate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New side chat"
          hitSlop={8}
          onPress={() => void startSideChat(props.threadId)}
        >
          <SymbolView name="plus.bubble" size={14} tintColorClassName="accent-foreground-muted" />
        </Pressable>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
        <View className="flex-row gap-1 pr-4">
          {sideChats.map((sideChat) => {
            const needs =
              sideChat.hasPendingApprovals || sideChat.pendingSubagentRequest === "approval"
                ? "approval"
                : sideChat.hasPendingUserInput || sideChat.pendingSubagentRequest
                  ? "input"
                  : null;
            return (
              <Menu
                key={sideChat.id}
                shouldOpenOnLongPress
                actions={[{ id: "detach", title: "Turn into thread", image: "arrow.up.message" }]}
                onPressAction={() => void turnIntoThread(sideChat.id)}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open side chat ${sideChat.title}${needs === null ? "" : `, needs ${needs}`}`}
                  className="max-w-48 flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1"
                  onPress={() =>
                    openLinkedThread({ environmentId: props.environmentId, threadId: sideChat.id })
                  }
                >
                  {needs === null ? null : (
                    <View
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        needs === "approval"
                          ? "bg-warning-foreground"
                          : "bg-adaptive-indigo-600-300",
                      )}
                    />
                  )}
                  <Text className="shrink text-xs text-foreground" numberOfLines={1}>
                    {sideChat.title}
                  </Text>
                </Pressable>
              </Menu>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
