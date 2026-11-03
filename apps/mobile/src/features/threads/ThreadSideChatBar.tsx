import { sideChatParentStatus, type SideChatParentTone } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import * as Dialog from "../../components/ui/Dialog";
import { useQuietThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStartSideChat } from "./useStartSideChat";

const TONE_DOT: Record<SideChatParentTone, string> = {
  active: "bg-adaptive-indigo-600-300",
  attention: "bg-warning-foreground",
  idle: "bg-foreground-muted",
  error: "bg-danger-foreground",
};

/** Shown on a side chat's own thread screen: its parent, what the parent is doing, and Start over. */
export function ThreadSideChatBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly canOperate: boolean;
}) {
  const parent = useQuietThreadShell(scopeThreadRef(props.environmentId, props.parentThreadId));
  const deleteThread = useAtomCommand(threadEnvironment.delete);
  const startSideChat = useStartSideChat(props.environmentId);
  const status = parent === null ? null : sideChatParentStatus(parent);
  const startOver = async () => {
    // The fresh side chat opens first, so a failed start leaves this one untouched.
    if ((await startSideChat(props.parentThreadId, { replace: true })) === null) return;
    await deleteThread({ environmentId: props.environmentId, input: { threadId: props.threadId } });
  };
  return (
    <View className="flex-row items-center gap-2 pr-4 pb-2 pl-4">
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        Side chat of{" "}
        <Text className="text-xs text-foreground">{parent?.title ?? "main thread"}</Text>
      </Text>
      {status === null ? null : (
        <View
          accessibilityRole="text"
          accessibilityLabel={`Main thread: ${status.label}`}
          className="flex-row items-center gap-1"
        >
          <View className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[status.tone])} />
          <Text className="text-xs text-foreground-muted">{status.label}</Text>
        </View>
      )}
      {props.canOperate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start over"
          hitSlop={8}
          onPress={() =>
            Dialog.confirm({
              title: "Start over?",
              message: "This permanently clears this side chat and opens a fresh one.",
              confirmText: "Start over",
              destructive: true,
              onConfirm: () => void startOver(),
            })
          }
        >
          <SymbolView
            name="arrow.counterclockwise"
            size={14}
            tintColorClassName="accent-foreground-muted"
          />
        </Pressable>
      ) : null}
    </View>
  );
}
